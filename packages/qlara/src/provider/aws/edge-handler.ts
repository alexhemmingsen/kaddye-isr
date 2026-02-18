/**
 * Lambda@Edge origin-request handler for Qlara.
 *
 * This file is bundled into a self-contained ZIP and deployed to Lambda@Edge.
 * It does NOT run in the developer's Node.js — it runs at CloudFront edge locations.
 *
 * Config values are injected at bundle time via esbuild `define` (Lambda@Edge has no env vars).
 *
 * Runs as an **origin-request** trigger so that generated responses are cached by CloudFront.
 * (Origin-response generated responses are NOT cached — documented AWS behavior.)
 *
 * Flow for a request to /product/5:
 * 1. CloudFront viewer-request rewrites /product/5 → /product/5.html
 * 2. CloudFront checks edge cache → miss → fires this origin-request handler
 * 3. Handler checks S3 for product/5.html:
 *    a. File exists → return it directly (CloudFront caches it)
 *    b. File doesn't exist → invoke renderer → return rendered HTML (CloudFront caches it)
 * 4. Subsequent requests hit CloudFront edge cache directly (~10-30ms)
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// ── Injected at bundle time by esbuild define ────────────────────
declare const __QLARA_BUCKET_NAME__: string;
declare const __QLARA_RENDERER_ARN__: string;
declare const __QLARA_REGION__: string;
declare const __QLARA_CACHE_TTL__: number;
// ── Types (inlined to keep bundle self-contained) ────────────────

interface ManifestRoute {
  pattern: string;
  paramNames: string[];
  regex: string;
}

interface QlaraManifest {
  version: 1;
  routes: ManifestRoute[];
}

interface RouteMatch {
  route: ManifestRoute;
  params: Record<string, string>;
}

interface CloudFrontResponse {
  status: string;
  statusDescription: string;
  headers: Record<string, Array<{ key: string; value: string }>>;
  body?: string;
  bodyEncoding?: string;
}

interface CloudFrontRequest {
  uri: string;
  querystring: string;
  method: string;
  headers: Record<string, Array<{ key: string; value: string }>>;
  origin?: Record<string, unknown>;
}

interface CloudFrontRequestEvent {
  Records: Array<{
    cf: {
      request: CloudFrontRequest;
    };
  }>;
}

// ── Constants ────────────────────────────────────────────────────

const FALLBACK_FILENAME = '_fallback.html';
const FALLBACK_PLACEHOLDER = '__QLARA_FALLBACK__';

// ── Caching ──────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T | null;
  expiry: number;
}

const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const FALLBACK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let manifestCache: CacheEntry<QlaraManifest> = { data: null, expiry: 0 };
const fallbackCache: Map<string, CacheEntry<string>> = new Map();

// ── Route matching (inlined from routes.ts) ──────────────────────

function matchRoute(url: string, routes: ManifestRoute[]): RouteMatch | null {
  const cleanUrl = url.split('?')[0].replace(/\/$/, '') || '/';

  for (const route of routes) {
    const regex = new RegExp(route.regex);
    const match = cleanUrl.match(regex);

    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { route, params };
    }
  }

  return null;
}

// ── S3 helpers ───────────────────────────────────────────────────

const s3 = new S3Client({ region: __QLARA_REGION__ });

async function getManifest(): Promise<QlaraManifest | null> {
  if (manifestCache.data && Date.now() < manifestCache.expiry) {
    return manifestCache.data;
  }

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: __QLARA_BUCKET_NAME__,
        Key: 'qlara-manifest.json',
      })
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) return null;

    const manifest = JSON.parse(body) as QlaraManifest;
    manifestCache = { data: manifest, expiry: Date.now() + MANIFEST_CACHE_TTL };
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Get the fallback HTML for a route.
 * Looks up the _fallback.html file in the route's directory in S3.
 *
 * '/product/:id' → reads 'product/_fallback.html' from S3
 */
async function getFallbackHtml(route: ManifestRoute): Promise<string | null> {
  // Derive the fallback S3 key from the route pattern
  const parts = route.pattern.replace(/^\//, '').split('/');
  const dirParts = parts.filter(p => !p.startsWith(':'));
  const fallbackKey = [...dirParts, FALLBACK_FILENAME].join('/');

  // Check cache
  const cached = fallbackCache.get(fallbackKey);
  if (cached?.data && Date.now() < cached.expiry) {
    return cached.data;
  }

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: __QLARA_BUCKET_NAME__,
        Key: fallbackKey,
      })
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) return null;

    fallbackCache.set(fallbackKey, {
      data: body,
      expiry: Date.now() + FALLBACK_CACHE_TTL,
    });
    return body;
  } catch {
    return null;
  }
}

/**
 * Patch the fallback HTML by replacing __QLARA_FALLBACK__ with actual param values.
 */
function patchFallback(html: string, params: Record<string, string>): string {
  let patched = html;

  // For now, all params use the same placeholder. Replace with the last param value
  // (which is the dynamic segment — e.g., the product ID).
  // For multi-param routes like /blog/:year/:slug, we'd need per-param placeholders.
  const paramValues = Object.values(params);
  const lastParam = paramValues[paramValues.length - 1] || '';

  patched = patched.replace(new RegExp(FALLBACK_PLACEHOLDER, 'g'), lastParam);

  return patched;
}

// ── Renderer invocation ──────────────────────────────────────────

const lambda = new LambdaClient({ region: __QLARA_REGION__ });

/**
 * Invoke the renderer Lambda synchronously and return the rendered HTML.
 * The renderer fetches metadata from the data source, patches the fallback HTML,
 * uploads to S3, and returns the fully rendered HTML.
 *
 * This ensures the first request for a new page gets full SEO metadata —
 * critical for crawlers that only visit once.
 *
 * Returns null if the renderer fails (caller falls back to unpatched HTML).
 */
async function invokeRenderer(uri: string, match: RouteMatch): Promise<string | null> {
  try {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: __QLARA_RENDERER_ARN__,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({
          uri,
          bucket: __QLARA_BUCKET_NAME__,
          routePattern: match.route.pattern,
          params: match.params,
        }),
      })
    );

    if (result.FunctionError || !result.Payload) {
      return null;
    }

    const payload = JSON.parse(new TextDecoder().decode(result.Payload));
    return payload.html || null;
  } catch {
    return null;
  }
}

// ── Response builder ─────────────────────────────────────────────

function buildHtmlResponse(html: string): CloudFrontResponse {
  return {
    status: '200',
    statusDescription: 'OK',
    headers: {
      'content-type': [
        { key: 'Content-Type', value: 'text/html; charset=utf-8' },
      ],
      'cache-control': [
        { key: 'Cache-Control', value: `public, max-age=0, s-maxage=${__QLARA_CACHE_TTL__}, stale-while-revalidate=60` },
      ],
    },
    body: html,
    bodyEncoding: 'text',
  };
}

// ── Handler ──────────────────────────────────────────────────────

export async function handler(
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequest | CloudFrontResponse> {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // 1. Non-HTML file requests → forward to S3 origin (handled normally by CloudFront)
  //    e.g. /product/20.txt (RSC flight data), /product/20.json, JS, CSS, images, etc.
  const nonHtmlExt = uri.match(/\.([a-z0-9]+)$/)?.[1];
  if (nonHtmlExt && nonHtmlExt !== 'html') {
    return request;
  }

  // 2. Try to get the file from S3 directly
  const s3Key = uri.replace(/^\//, '');
  if (s3Key) {
    try {
      const s3Response = await s3.send(
        new GetObjectCommand({
          Bucket: __QLARA_BUCKET_NAME__,
          Key: s3Key,
        })
      );
      const body = await s3Response.Body?.transformToString('utf-8');
      if (body) {
        // File exists in S3 → return it directly (CloudFront will cache this)
        return buildHtmlResponse(body);
      }
    } catch {
      // File doesn't exist in S3 — continue to dynamic route handling
    }
  }

  // 3. Fetch manifest and check if this URL matches a Qlara dynamic route
  // Strip .html suffix that the URL rewrite function adds before matching
  const cleanUri = uri.replace(/\.html$/, '');
  const manifest = await getManifest();
  const match = manifest ? matchRoute(cleanUri, manifest.routes) : null;

  // 4. If route matches: invoke renderer synchronously to get fully rendered HTML
  if (match) {
    // Try to render with full SEO metadata (synchronous — waits for result)
    const renderedHtml = await invokeRenderer(cleanUri, match);

    if (renderedHtml) {
      return buildHtmlResponse(renderedHtml);
    }

    // Renderer failed — fall back to unpatched fallback HTML (no SEO, but page still works)
    const fallbackHtml = await getFallbackHtml(match.route);
    if (fallbackHtml) {
      const patchedHtml = patchFallback(fallbackHtml, match.params);
      return buildHtmlResponse(patchedHtml);
    }
  }

  // 5. No match or no fallback — forward to origin (S3 will return 403/404)
  return request;
}
