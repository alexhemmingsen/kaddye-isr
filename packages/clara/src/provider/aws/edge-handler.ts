/**
 * Lambda@Edge origin-response handler for Clara.
 *
 * This file is bundled into a self-contained ZIP and deployed to Lambda@Edge.
 * It does NOT run in the developer's Node.js — it runs at CloudFront edge locations.
 *
 * Config values are injected at bundle time via esbuild `define` (Lambda@Edge has no env vars).
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// ── Injected at bundle time by esbuild define ────────────────────
declare const __CLARA_BUCKET_NAME__: string;
declare const __CLARA_RENDERER_ARN__: string;
declare const __CLARA_REGION__: string;
declare const __CLARA_DISTRIBUTION_DOMAIN__: string;

// ── Types (inlined to keep bundle self-contained) ────────────────

interface ManifestRoute {
  pattern: string;
  paramNames: string[];
  regex: string;
}

interface ClaraManifest {
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
}

interface CloudFrontRequest {
  uri: string;
  querystring: string;
}

interface CloudFrontResponseEvent {
  Records: Array<{
    cf: {
      request: CloudFrontRequest;
      response: CloudFrontResponse;
    };
  }>;
}

// ── Caching ──────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T | null;
  expiry: number;
}

const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const INDEX_CACHE_TTL = 60 * 1000; // 1 minute

let manifestCache: CacheEntry<ClaraManifest> = { data: null, expiry: 0 };
let indexHtmlCache: CacheEntry<string> = { data: null, expiry: 0 };

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

const s3 = new S3Client({ region: __CLARA_REGION__ });

async function getManifest(): Promise<ClaraManifest | null> {
  if (manifestCache.data && Date.now() < manifestCache.expiry) {
    return manifestCache.data;
  }

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: __CLARA_BUCKET_NAME__,
        Key: 'clara-manifest.json',
      })
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) return null;

    const manifest = JSON.parse(body) as ClaraManifest;
    manifestCache = { data: manifest, expiry: Date.now() + MANIFEST_CACHE_TTL };
    return manifest;
  } catch {
    return null;
  }
}

async function getIndexHtml(): Promise<string | null> {
  if (indexHtmlCache.data && Date.now() < indexHtmlCache.expiry) {
    return indexHtmlCache.data;
  }

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: __CLARA_BUCKET_NAME__,
        Key: 'index.html',
      })
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) return null;

    indexHtmlCache = { data: body, expiry: Date.now() + INDEX_CACHE_TTL };
    return body;
  } catch {
    return null;
  }
}

// ── Renderer invocation ──────────────────────────────────────────

const lambda = new LambdaClient({ region: __CLARA_REGION__ });

async function invokeRenderer(uri: string): Promise<string | null> {
  try {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: __CLARA_RENDERER_ARN__,
        InvocationType: 'RequestResponse', // synchronous — wait for rendered HTML
        Payload: JSON.stringify({
          uri,
          bucket: __CLARA_BUCKET_NAME__,
          distributionDomain: __CLARA_DISTRIBUTION_DOMAIN__,
        }),
      })
    );

    if (result.Payload) {
      const payload = JSON.parse(
        typeof result.Payload === 'string'
          ? result.Payload
          : new TextDecoder().decode(result.Payload)
      );
      if (payload.statusCode === 200) {
        const body = JSON.parse(payload.body);
        return body.html || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Response builder ─────────────────────────────────────────────

// Lambda@Edge read-only headers — must be preserved from the original response
const READ_ONLY_HEADERS = ['transfer-encoding', 'via'];

function buildHtmlResponse(
  html: string,
  originalResponse: CloudFrontResponse
): CloudFrontResponse {
  const headers: Record<string, Array<{ key: string; value: string }>> = {
    'content-type': [
      { key: 'Content-Type', value: 'text/html; charset=utf-8' },
    ],
    'cache-control': [
      { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
    ],
  };

  // Preserve read-only headers from the original response to avoid 502
  for (const headerName of READ_ONLY_HEADERS) {
    if (originalResponse.headers[headerName]) {
      headers[headerName] = originalResponse.headers[headerName];
    }
  }

  return {
    status: '200',
    statusDescription: 'OK',
    headers,
    body: html,
  };
}

// ── Handler ──────────────────────────────────────────────────────

export async function handler(
  event: CloudFrontResponseEvent
): Promise<CloudFrontResponse> {
  const record = event.Records[0].cf;
  const response = record.response;
  const request = record.request;
  const uri = request.uri;
  const querystring = request.querystring || '';
  const status = parseInt(response.status, 10);
  const isBypass = querystring.includes('__clara_bypass');

  // 1. If response is 200 (file exists in S3), pass through
  if (status !== 403 && status !== 404) {
    return response;
  }

  // At this point, the file does NOT exist in S3 (403 from OAC or 404)

  // 2. If bypass param is present: serve index.html but do NOT invoke renderer.
  //    This is used by Puppeteer — it needs the SPA shell to render the page,
  //    but we must not trigger another render (infinite loop).
  if (isBypass) {
    const html = await getIndexHtml();
    if (!html) return response; // Can't help — return original error
    return buildHtmlResponse(html, response);
  }

  // 3. Fetch manifest and check if this URL matches a Clara dynamic route
  const manifest = await getManifest();
  const match = manifest ? matchRoute(uri, manifest.routes) : null;

  // 4. If route matches: invoke the renderer synchronously and serve the result
  if (match) {
    const renderedHtml = await invokeRenderer(uri);
    if (renderedHtml) {
      return buildHtmlResponse(renderedHtml, response);
    }
  }

  // 5. Fallback: serve index.html as SPA shell
  const html = await getIndexHtml();
  if (!html) return response; // Can't help — return original error
  return buildHtmlResponse(html, response);
}
