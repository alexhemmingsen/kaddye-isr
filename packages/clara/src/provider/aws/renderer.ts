/**
 * Renderer Lambda for Clara.
 *
 * This file is bundled into a self-contained ZIP and deployed as a standard Lambda.
 * It does NOT run in the developer's Node.js — it runs in AWS Lambda.
 *
 * The renderer:
 * 1. Reads the route's _fallback.html from S3
 * 2. Patches the __CLARA_FALLBACK__ placeholder with the actual param value
 * 3. Calls the developer's metaDataGenerator to fetch metadata from the data source
 * 4. Patches <title>, <meta> tags, and RSC flight data with real metadata
 * 5. Uploads the final SEO-complete HTML to S3 for future requests
 *
 * The route file is bundled by esbuild at deploy time. It exports an array of
 * route definitions, each with a pattern and a metaDataGenerator function.
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { ClaraMetadata } from '../../types.js';

// The routes module is resolved by esbuild at deploy time.
// esbuild's `alias` option maps this import to the developer's route file.
// At bundle time: '__clara_routes__' → './clara.routes.ts' (or wherever the dev put it)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — resolved at bundle time by esbuild alias
import routes from '__clara_routes__';

interface RendererEvent {
  /** The request URI, e.g. '/product/42' */
  uri: string;
  /** S3 bucket name to upload the rendered HTML to */
  bucket: string;
  /** The route pattern that matched, e.g. '/product/:id' */
  routePattern: string;
  /** The extracted route params, e.g. { id: '42' } */
  params: Record<string, string>;
}

interface RendererResult {
  statusCode: number;
  body: string;
  /** The fully rendered HTML — used by the edge handler to serve on first request */
  html?: string;
}

const FALLBACK_PLACEHOLDER = '__CLARA_FALLBACK__';

/**
 * Derive the S3 key for a rendered page.
 * Matches the Next.js static export convention: /product/42 → product/42.html
 */
function deriveS3Key(uri: string): string {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanUri) return 'index.html';
  return `${cleanUri}.html`;
}

/**
 * Derive the fallback S3 key from a URI.
 * /product/42 → product/_fallback.html
 */
function deriveFallbackKey(uri: string): string {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  const parts = cleanUri.split('/');
  if (parts.length < 2) return '_fallback.html';
  return parts.slice(0, -1).join('/') + '/_fallback.html';
}

/**
 * Extract the last path segment (the dynamic param value) from a URI.
 * /product/42 → '42'
 */
function extractParamValue(uri: string): string {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  return cleanUri.split('/').pop() || '';
}

/**
 * Patch the HTML with real metadata from the metaDataGenerator.
 * This produces output identical to what Next.js generates at build time.
 */
function patchMetadata(html: string, metadata: ClaraMetadata): string {
  let patched = html;

  const title = metadata.title;
  const description = metadata.description || '';
  const ogTitle = metadata.openGraph?.title || title;
  const ogDescription = metadata.openGraph?.description || description;

  // 1. Update <title> tag
  patched = patched.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title)}</title>`
  );

  // 2. Remove existing SEO meta tags (React may have removed empty ones during hydration,
  //    but the fallback template still has them)
  patched = patched.replace(/<meta name="description" content="[^"]*"\s*\/?>/g, '');
  patched = patched.replace(/<meta property="og:title" content="[^"]*"\s*\/?>/g, '');
  patched = patched.replace(/<meta property="og:description" content="[^"]*"\s*\/?>/g, '');
  patched = patched.replace(/<meta name="twitter:card" content="[^"]*"\s*\/?>/g, '');
  patched = patched.replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/g, '');
  patched = patched.replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/g, '');

  // 3. Inject meta tags after </title> — matches build-time output format
  const metaTags = [
    description ? `<meta name="description" content="${escapeAttr(description)}"/>` : '',
    `<meta property="og:title" content="${escapeAttr(ogTitle)}"/>`,
    ogDescription ? `<meta property="og:description" content="${escapeAttr(ogDescription)}"/>` : '',
    `<meta name="twitter:card" content="summary"/>`,
    `<meta name="twitter:title" content="${escapeAttr(title)}"/>`,
    description ? `<meta name="twitter:description" content="${escapeAttr(description)}"/>` : '',
  ].filter(Boolean).join('');

  patched = patched.replace(
    /(<\/title>)/,
    `$1${metaTags}`
  );

  // 4. Patch RSC flight data so React doesn't overwrite metadata on hydration.
  //    RSC data lives inside <script>self.__next_f.push([1,"..."])</script>
  //    where quotes are escaped as \". We must match and replace in that form.
  //    Build-time format:
  //    8:{"metadata":[[...title...],[...meta tags...]],\"error\":null,\"digest\":\"$undefined\"}
  const q = '\\"'; // escaped quote as it appears in the HTML script

  const metadataEntries = [
    `[${q}$${q},${q}title${q},${q}0${q},{${q}children${q}:${q}${escapeRsc(title)}${q}}]`,
    description ? `,[${q}$${q},${q}meta${q},${q}1${q},{${q}name${q}:${q}description${q},${q}content${q}:${q}${escapeRsc(description)}${q}}]` : '',
    `,[${q}$${q},${q}meta${q},${q}2${q},{${q}property${q}:${q}og:title${q},${q}content${q}:${q}${escapeRsc(ogTitle)}${q}}]`,
    ogDescription ? `,[${q}$${q},${q}meta${q},${q}3${q},{${q}property${q}:${q}og:description${q},${q}content${q}:${q}${escapeRsc(ogDescription)}${q}}]` : '',
    `,[${q}$${q},${q}meta${q},${q}4${q},{${q}name${q}:${q}twitter:card${q},${q}content${q}:${q}summary${q}}]`,
    `,[${q}$${q},${q}meta${q},${q}5${q},{${q}name${q}:${q}twitter:title${q},${q}content${q}:${q}${escapeRsc(title)}${q}}]`,
    description ? `,[${q}$${q},${q}meta${q},${q}6${q},{${q}name${q}:${q}twitter:description${q},${q}content${q}:${q}${escapeRsc(description)}${q}}]` : '',
  ].filter(Boolean).join('');

  patched = patched.replace(
    /8:\{\\\"metadata\\\":\[[\s\S]*?\],\\\"error\\\":null,\\\"digest\\\":\\\"?\$undefined\\\"?\}/,
    `8:{\\\"metadata\\\":[${metadataEntries}],\\\"error\\\":null,\\\"digest\\\":\\\"$undefined\\\"}`
  );

  return patched;
}

export async function handler(event: RendererEvent): Promise<RendererResult> {
  const { uri, bucket, routePattern, params } = event;
  const region = process.env.AWS_REGION || 'us-east-1';

  const s3 = new S3Client({ region });

  try {
    // 1. Read the fallback HTML from S3
    const fallbackKey = deriveFallbackKey(uri);
    let fallbackHtml: string;

    try {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: fallbackKey })
      );
      fallbackHtml = (await response.Body?.transformToString('utf-8')) || '';
      if (!fallbackHtml) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Empty fallback at ${fallbackKey}` }),
        };
      }
    } catch {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Fallback not found: ${fallbackKey}` }),
      };
    }

    // 2. Patch the fallback with the actual param value
    const paramValue = extractParamValue(uri);
    let html = fallbackHtml.replace(
      new RegExp(FALLBACK_PLACEHOLDER, 'g'),
      paramValue
    );

    // 3. Call the metaDataGenerator to fetch metadata from the data source
    const routeDef = routes?.find((r: { route: string }) => r.route === routePattern);

    if (routeDef?.metaDataGenerator) {
      const metadata = await routeDef.metaDataGenerator(params);
      if (metadata) {
        // 4. Patch the HTML with real metadata
        html = patchMetadata(html, metadata);
      }
    }

    // 5. Upload to S3
    const s3Key = deriveS3Key(uri);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: html,
        ContentType: 'text/html; charset=utf-8',
        CacheControl:
          'public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400',
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Rendered and cached: ${uri}`,
        key: s3Key,
      }),
      html,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Render failed for ${uri}: ${(err as Error).message}`,
      }),
    };
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRsc(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
