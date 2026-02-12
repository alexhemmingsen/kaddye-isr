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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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

export async function handler(event: RendererEvent): Promise<RendererResult> {
  const { uri, bucket, distributionDomain } = event;
  const region = process.env.AWS_REGION || 'us-east-1';

  if (!distributionDomain) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'distributionDomain not provided in event' }),
    };
  }

  let browser;

  try {
    // 1. Launch headless Chrome
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // 2. Navigate to the page via CloudFront with bypass param
    //    The bypass param tells the edge handler to serve index.html
    //    without triggering another render (prevents infinite loop)
    const url = `https://${distributionDomain}${uri}?__clara_bypass=1`;

    await page.goto(url, {
      waitUntil: 'networkidle0', // No network requests for 500ms
      timeout: 30000,
    });

    // 3. Capture the fully rendered HTML
    const html = await page.content();

    // 4. Upload to S3
    const s3Key = deriveS3Key(uri);
    const s3 = new S3Client({ region });

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
