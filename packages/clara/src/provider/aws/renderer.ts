/**
 * Renderer Lambda for Clara.
 *
 * This file is bundled into a self-contained ZIP and deployed as a standard Lambda.
 * It does NOT run in the developer's Node.js — it runs in AWS Lambda.
 *
 * The renderer uses Puppeteer with @sparticuz/chromium to:
 * 1. Load a page via CloudFront (with bypass param to get the SPA shell)
 * 2. Wait for the SPA to fully render (client-side data fetching + rendering)
 * 3. Capture the complete HTML (with meta tags, OG tags, etc.)
 * 4. Upload the static HTML to S3 for future requests
 *
 * @sparticuz/chromium is provided via a Lambda Layer (marked as external in the bundle).
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

interface RendererEvent {
  /** The request URI, e.g. '/product/42' */
  uri: string;
  /** S3 bucket name to upload the rendered HTML to */
  bucket: string;
  /** CloudFront distribution domain for loading the SPA shell */
  distributionDomain: string;
}

interface RendererResult {
  statusCode: number;
  body: string;
}

/**
 * Derive the S3 key for a rendered page.
 * Matches the Next.js static export convention: /product/42 → product/42.html
 */
function deriveS3Key(uri: string): string {
  // Remove leading slash
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanUri) return 'index.html';
  return `${cleanUri}.html`;
}

/**
 * Find an existing HTML file in the same route directory to use as a shell template.
 * For /product/5 → look for any existing product/*.html in S3.
 */
async function findShellTemplate(
  s3: S3Client,
  bucket: string,
  uri: string
): Promise<string | null> {
  // Get the route prefix: /product/5 → product/
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  const parts = cleanUri.split('/');
  if (parts.length < 2) return null;

  const prefix = parts.slice(0, -1).join('/') + '/';

  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 10,
      })
    );

    // Find the first .html file
    const htmlFile = list.Contents?.find((obj) => obj.Key?.endsWith('.html'));
    if (!htmlFile?.Key) return null;

    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: htmlFile.Key })
    );
    return (await response.Body?.transformToString('utf-8')) || null;
  } catch {
    return null;
  }
}

/**
 * Patch the RSC flight data in a product page HTML to render a different product.
 * Replaces the `id` prop and sets `initial` to null so the client component
 * fetches the product from Supabase at runtime.
 */
function patchShellForNewId(html: string, targetId: string): string {
  // The RSC flight data contains a line like:
  // 4:["$","$Lf",null,{"id":"1","initial":{"id":"1","name":"...","description":"...","price":...}}]
  // We need to change "id" to the target and set "initial" to null.
  //
  // Also patch the route segment: "children":["product",... ["id","1","d"]
  // to use the target ID.

  let patched = html;

  // Patch the ProductDetail props: {"id":"X","initial":{...}} → {"id":"TARGET","initial":null}
  patched = patched.replace(
    /\{"id":"[^"]+","initial":\{[^}]*\}\}/g,
    `{"id":"${targetId}","initial":null}`
  );

  // Patch the route segment: ["id","X","d"] → ["id","TARGET","d"]
  patched = patched.replace(
    /\["id","[^"]+","d"\]/g,
    `["id","${targetId}","d"]`
  );

  // Patch the URL segments in the flight data: "c":["","product","X"] → "c":["","product","TARGET"]
  patched = patched.replace(
    /("c":\["","product",)"[^"]+"\]/g,
    `$1"${targetId}"]`
  );

  // Patch metadata title (optional, will be overwritten after render)
  patched = patched.replace(
    /\{"children":"[^"]*\s*\|\s*Food Store"\}/g,
    `{"children":"Product ${targetId} | Food Store"}`
  );

  return patched;
}

export async function handler(event: RendererEvent): Promise<RendererResult> {
  const { uri, bucket, distributionDomain } = event;
  const region = process.env.AWS_REGION || 'us-east-1';

  if (!distributionDomain) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'distributionDomain not provided in event' }),
    };
  }

  const s3 = new S3Client({ region });
  let browser;

  try {
    // 1. Find an existing page in the same route directory to use as a template
    const shellHtml = await findShellTemplate(s3, bucket, uri);

    // 2. Launch headless Chrome
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    let url: string;

    if (shellHtml) {
      // 3a. Use request interception to serve the patched shell template
      //     Extract the target ID from the URI (last path segment)
      const targetId = uri.replace(/^\//, '').replace(/\/$/, '').split('/').pop() || '';
      const patchedHtml = patchShellForNewId(shellHtml, targetId);

      await page.setRequestInterception(true);

      let documentIntercepted = false;
      page.on('request', (request) => {
        if (request.resourceType() === 'document' && !documentIntercepted) {
          documentIntercepted = true;
          request.respond({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: patchedHtml,
          });
        } else {
          request.continue();
        }
      });

      url = `https://${distributionDomain}${uri}`;
    } else {
      // 3b. Fallback: load via CloudFront bypass (serves index.html)
      url = `https://${distributionDomain}${uri}?__clara_bypass=1`;
    }

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // 4. Capture the fully rendered HTML
    const html = await page.content();

    // 5. Upload to S3
    const s3Key = deriveS3Key(uri);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: html,
        ContentType: 'text/html; charset=utf-8',
        CacheControl: 'public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400',
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Rendered and cached: ${uri}`,
        key: s3Key,
        html,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Render failed for ${uri}: ${(err as Error).message}`,
      }),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
