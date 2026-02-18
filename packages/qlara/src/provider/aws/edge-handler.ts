/**
 * Lambda@Edge origin-request handler for Qlara.
 *
 * This file is bundled into a self-contained ZIP and deployed to Lambda@Edge.
 * It does NOT run in the developer's Node.js — it runs at CloudFront edge locations.
 *
 * Config values are injected at bundle time via esbuild `define` (Lambda@Edge has no env vars).
 *
 * Runs as an **origin-request** trigger. The handler NEVER generates responses —
 * it always forwards the request to S3 origin. This ensures CloudFront caches
 * the S3 origin response natively, with identical behavior for build-time and
 * renderer-generated pages.
 *
 * Flow for a request to /product/5:
 * 1. CloudFront viewer-request rewrites /product/5 → /product/5.html
 * 2. CloudFront checks edge cache → miss → fires this origin-request handler
 * 3. Handler checks S3 for product/5.html:
 *    a. File exists → forward to S3 origin (CloudFront caches the S3 response)
 *    b. File doesn't exist → invoke renderer (uploads to S3) → forward to S3 origin
 * 4. CloudFront caches the S3 response at the edge
 * 5. Subsequent requests hit CloudFront edge cache directly (~10-30ms)
 */

import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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

const FALLBACK_PLACEHOLDER = '__QLARA_FALLBACK__';

// ── Caching ──────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T | null;
  expiry: number;
}

const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let manifestCache: CacheEntry<QlaraManifest> = { data: null, expiry: 0 };

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
 * Check if a file exists in S3 using HEAD request (no body transfer).
 */
async function fileExistsInS3(key: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: __QLARA_BUCKET_NAME__,
        Key: key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

// ── Renderer invocation ──────────────────────────────────────────

const lambda = new LambdaClient({ region: __QLARA_REGION__ });

/**
 * Invoke the renderer Lambda synchronously.
 * The renderer fetches metadata from the data source, patches the fallback HTML,
 * and uploads the final HTML to S3.
 *
 * We wait for the renderer to complete so the file exists in S3 before
 * CloudFront forwards the request to origin.
 */
async function invokeRenderer(uri: string, match: RouteMatch): Promise<void> {
  try {
    await lambda.send(
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
  } catch {
    // Renderer failed — S3 will return 403/404, which is acceptable
  }
}

// ── Handler ──────────────────────────────────────────────────────

/**
 * Origin-request handler.
 *
 * ALWAYS returns the request object (forward to S3 origin).
 * Never generates responses — CloudFront caches S3 origin responses natively.
 *
 * For dynamic routes where the file doesn't exist yet, the renderer is invoked
 * synchronously to upload the HTML to S3 before forwarding.
 */
export async function handler(
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequest> {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // 1. Non-HTML file requests → forward to S3 origin directly
  //    e.g. /product/20.txt (RSC flight data), JS, CSS, images, etc.
  const nonHtmlExt = uri.match(/\.([a-z0-9]+)$/)?.[1];
  if (nonHtmlExt && nonHtmlExt !== 'html') {
    return request;
  }

  // 2. Check if the HTML file exists in S3 (HEAD — no body transfer)
  const s3Key = uri.replace(/^\//, '');
  let fileExists = false;

  if (s3Key) {
    fileExists = await fileExistsInS3(s3Key);
  }

  // 3. File exists → forward to S3 (CloudFront will cache the S3 response)
  if (fileExists) {
    return request;
  }

  // 4. File missing → check if this matches a dynamic route
  const cleanUri = uri.replace(/\.html$/, '');
  const manifest = await getManifest();
  const match = manifest ? matchRoute(cleanUri, manifest.routes) : null;

  if (match) {
    // 5. Invoke renderer synchronously — it uploads the HTML to S3
    await invokeRenderer(cleanUri, match);
    // File now exists in S3 — forward to S3 origin
  }

  // 6. Forward to S3 origin
  //    - If renderer succeeded: S3 returns 200 → CloudFront caches ✅
  //    - If renderer failed or no match: S3 returns 403/404
  return request;
}
