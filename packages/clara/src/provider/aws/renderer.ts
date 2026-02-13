/**
 * Renderer Lambda for Clara.
 *
 * This file is bundled into a self-contained ZIP and deployed as a standard Lambda.
 * It does NOT run in the developer's Node.js — it runs in AWS Lambda.
 *
 * The renderer:
 * 1. Reads the route's _fallback.html from S3
 * 2. Patches the __CLARA_FALLBACK__ placeholder with the actual param value
 * 3. Uses Puppeteer request interception to serve this HTML as the document
 *    (sub-resources like JS/CSS are loaded normally from CloudFront)
 * 4. Waits for client-side rendering to complete (data fetching + React hydration)
 * 5. Extracts SEO metadata from the rendered DOM (title, description, og tags)
 * 6. Patches the HTML <head> with the correct metadata
 * 7. Uploads the final SEO-complete HTML to S3 for future requests
 *
 * @sparticuz/chromium is provided via a Lambda Layer (marked as external in the bundle).
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

interface RendererEvent {
  /** The request URI, e.g. '/product/42' */
  uri: string;
  /** S3 bucket name to upload the rendered HTML to */
  bucket: string;
  /** CloudFront distribution domain for loading sub-resources (JS, CSS) */
  distributionDomain: string;
}

interface RendererResult {
  statusCode: number;
  body: string;
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
    const patchedHtml = fallbackHtml.replace(
      new RegExp(FALLBACK_PLACEHOLDER, 'g'),
      paramValue
    );

    // 3. Launch headless Chrome
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // 4. Use request interception to serve the patched fallback as the document
    //    All sub-resources (JS, CSS, fonts) load normally from CloudFront
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

    // Navigate to the CloudFront URL — the document request is intercepted,
    // but JS/CSS requests go through to CloudFront normally
    const url = `https://${distributionDomain}${uri}`;
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // 5. Wait a bit for any final renders, then capture the HTML
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 6. Extract SEO metadata from the rendered DOM
    //    The callback runs in the browser context (Puppeteer), not Node.js
    const seoData = await page.evaluate(() => {
      /* eslint-disable no-undef */
      return {
        title: (globalThis as any).document.title || '',
        h1: (globalThis as any).document.querySelector('h1')?.textContent || '',
        description:
          (globalThis as any).document
            .querySelector('meta[name="description"]')
            ?.getAttribute('content') || '',
      };
    });

    // 7. Get the full rendered HTML
    let html = await page.content();

    // 8. Patch the <head> with proper SEO metadata from the rendered content
    //    The client component should set document.title after fetching data.
    //    We also generate og: tags from the rendered content.
    if (seoData.title && seoData.title !== 'Loading...') {
      // Title was set by the client component — use it
      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(seoData.title)}</title>`
      );
    } else if (seoData.h1) {
      // Fallback: use the h1 content as the title
      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(seoData.h1)}</title>`
      );
    }

    // Update meta tags with rendered content
    const description = seoData.description || seoData.h1 || '';
    if (description) {
      html = html.replace(
        /<meta name="description" content="[^"]*"\/>/,
        `<meta name="description" content="${escapeAttr(description)}"/>`
      );
      html = html.replace(
        /<meta property="og:title" content="[^"]*"\/>/,
        `<meta property="og:title" content="${escapeAttr(seoData.title || seoData.h1)}"/>`
      );
      html = html.replace(
        /<meta property="og:description" content="[^"]*"\/>/,
        `<meta property="og:description" content="${escapeAttr(description)}"/>`
      );
      html = html.replace(
        /<meta name="twitter:title" content="[^"]*"\/>/,
        `<meta name="twitter:title" content="${escapeAttr(seoData.title || seoData.h1)}"/>`
      );
      html = html.replace(
        /<meta name="twitter:description" content="[^"]*"\/>/,
        `<meta name="twitter:description" content="${escapeAttr(description)}"/>`
      );
    }

    // 9. Upload to S3
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
        title: seoData.title,
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
