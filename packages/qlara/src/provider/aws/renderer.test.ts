/**
 * Tests for the renderer's S3 key derivation logic.
 *
 * The deriveS3Key function determines where in S3 a rendered page gets stored.
 * It must align with:
 * 1. Next.js static export convention (product/1.html, not product/1/index.html)
 * 2. The CloudFront Function URL rewrite (/product/42 → /product/42.html)
 */

import { describe, it, expect } from 'vitest';

// ── Inline deriveS3Key from renderer.ts for testing ──────────────
// (Same logic — the renderer.ts file can't be imported directly because
// it imports the '__qlara_routes__' virtual module resolved at bundle time)

function deriveS3Key(uri: string): string {
  const cleanUri = uri.replace(/^\//, '').replace(/\/$/, '');
  if (!cleanUri) return 'index.html';
  return `${cleanUri}.html`;
}

describe('deriveS3Key', () => {
  // ── Standard dynamic routes ────────────────────────────────────

  it('/product/42 → product/42.html', () => {
    expect(deriveS3Key('/product/42')).toBe('product/42.html');
  });

  it('/product/abc-123 → product/abc-123.html', () => {
    expect(deriveS3Key('/product/abc-123')).toBe('product/abc-123.html');
  });

  it('/blog/2024/my-post → blog/2024/my-post.html', () => {
    expect(deriveS3Key('/blog/2024/my-post')).toBe('blog/2024/my-post.html');
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it('root path / → index.html', () => {
    expect(deriveS3Key('/')).toBe('index.html');
  });

  it('empty string → index.html', () => {
    expect(deriveS3Key('')).toBe('index.html');
  });

  it('trailing slash is stripped: /product/42/ → product/42.html', () => {
    expect(deriveS3Key('/product/42/')).toBe('product/42.html');
  });

  it('no leading slash: product/42 → product/42.html', () => {
    expect(deriveS3Key('product/42')).toBe('product/42.html');
  });

  // ── Single segment ─────────────────────────────────────────────

  it('/about → about.html', () => {
    expect(deriveS3Key('/about')).toBe('about.html');
  });

  // ── Deeply nested ──────────────────────────────────────────────

  it('/a/b/c/d → a/b/c/d.html', () => {
    expect(deriveS3Key('/a/b/c/d')).toBe('a/b/c/d.html');
  });
});

// ── CloudFront Function alignment ────────────────────────────────

describe('CloudFront Function URL rewrite alignment', () => {
  /**
   * The CloudFront Function rewrites:
   *   /          → /index.html
   *   /about/    → /about/index.html
   *   /product/42 → /product/42.html  (no dot in path = append .html)
   *
   * The renderer writes:
   *   /product/42 → product/42.html
   *
   * These must match: the CF Function rewrites the request URI to
   * /product/42.html, and S3 has product/42.html (no leading slash in S3 keys).
   */

  function cfFunctionRewrite(uri: string): string {
    if (uri === '/') return '/index.html';
    if (uri.endsWith('/')) return uri + 'index.html';
    if (!uri.includes('.')) return uri + '.html';
    return uri;
  }

  it('CF rewrite of /product/42 matches renderer S3 key', () => {
    const cfResult = cfFunctionRewrite('/product/42'); // → /product/42.html
    const s3Key = deriveS3Key('/product/42'); // → product/42.html

    // CF result has leading slash, S3 key doesn't — but they refer to the same object
    expect(cfResult).toBe('/' + s3Key);
  });

  it('CF rewrite of /blog/2024/my-post matches renderer S3 key', () => {
    const cfResult = cfFunctionRewrite('/blog/2024/my-post');
    const s3Key = deriveS3Key('/blog/2024/my-post');

    expect(cfResult).toBe('/' + s3Key);
  });

  it('CF rewrite of / matches root index.html', () => {
    const cfResult = cfFunctionRewrite('/');
    expect(cfResult).toBe('/index.html');
  });

  it('CF rewrite does not touch files with extensions', () => {
    expect(cfFunctionRewrite('/style.css')).toBe('/style.css');
    expect(cfFunctionRewrite('/script.js')).toBe('/script.js');
    expect(cfFunctionRewrite('/image.png')).toBe('/image.png');
  });
});
