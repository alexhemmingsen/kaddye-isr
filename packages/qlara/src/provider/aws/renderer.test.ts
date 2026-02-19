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

// ── Fallback key derivation (inlined from renderer.ts) ────────────

function deriveFallbackKey(routePattern: string): string {
  const parts = routePattern.replace(/^\//, '').split('/');
  const dirParts = parts.filter(p => !p.startsWith(':'));
  return [...dirParts, '_fallback.html'].join('/');
}

describe('deriveFallbackKey', () => {
  it('single-param: /product/:id → product/_fallback.html', () => {
    expect(deriveFallbackKey('/product/:id')).toBe('product/_fallback.html');
  });

  it('multi-param: /:lang/products/:id → products/_fallback.html', () => {
    expect(deriveFallbackKey('/:lang/products/:id')).toBe('products/_fallback.html');
  });

  it('multi-param: /blog/:year/:slug → blog/_fallback.html', () => {
    expect(deriveFallbackKey('/blog/:year/:slug')).toBe('blog/_fallback.html');
  });

  it('all dynamic: /:a/:b/:c → _fallback.html', () => {
    expect(deriveFallbackKey('/:a/:b/:c')).toBe('_fallback.html');
  });

  it('mixed: /:lang/shop/:category/items/:id → shop/items/_fallback.html', () => {
    expect(deriveFallbackKey('/:lang/shop/:category/items/:id')).toBe('shop/items/_fallback.html');
  });
});

// ── Per-param placeholder (inlined from renderer.ts) ──────────────

function paramPlaceholder(paramName: string): string {
  return `__QLARA_FALLBACK_${paramName}__`;
}

describe('paramPlaceholder', () => {
  it('generates per-param placeholder', () => {
    expect(paramPlaceholder('id')).toBe('__QLARA_FALLBACK_id__');
    expect(paramPlaceholder('lang')).toBe('__QLARA_FALLBACK_lang__');
  });
});

describe('per-param placeholder replacement', () => {
  it('replaces single-param placeholder', () => {
    const html = 'value=__QLARA_FALLBACK_id__ other=__QLARA_FALLBACK_id__';
    let result = html;
    for (const [name, value] of Object.entries({ id: '42' })) {
      result = result.replace(new RegExp(paramPlaceholder(name), 'g'), value);
    }
    expect(result).toBe('value=42 other=42');
  });

  it('replaces multi-param placeholders independently', () => {
    const html = 'lang=__QLARA_FALLBACK_lang__ id=__QLARA_FALLBACK_id__';
    let result = html;
    for (const [name, value] of Object.entries({ lang: 'en', id: '99' })) {
      result = result.replace(new RegExp(paramPlaceholder(name), 'g'), value);
    }
    expect(result).toBe('lang=en id=99');
  });

  it('does not cross-replace different param placeholders', () => {
    const html = '__QLARA_FALLBACK_lang__ stays __QLARA_FALLBACK_id__';
    // Only replace lang, not id
    let result = html;
    for (const [name, value] of Object.entries({ lang: 'da' })) {
      result = result.replace(new RegExp(paramPlaceholder(name), 'g'), value);
    }
    expect(result).toBe('da stays __QLARA_FALLBACK_id__');
  });
});

// ── Segment file functions (inlined from renderer.ts) ─────────────

type SegmentFileType = 'shared' | 'tree' | 'head' | 'full' | 'page';

function classifySegmentFile(name: string): SegmentFileType {
  if (name === '__next._tree.txt') return 'tree';
  if (name === '__next._head.txt') return 'head';
  if (name === '__next._full.txt') return 'full';
  if (name.includes('__PAGE__')) return 'page';
  return 'shared';
}

function patchTreeSegment(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [name, value] of Object.entries(params)) {
    result = result.replace(
      new RegExp(`"name":"${name}","paramType":"d","paramKey":"[^"]*"`),
      `"name":"${name}","paramType":"d","paramKey":"${value}"`
    );
  }
  return result;
}

function patchPageSegment(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(
      new RegExp(`"${key}":"[^"]*"`),
      `"${key}":"${value}"`
    );
  }
  return result;
}

describe('classifySegmentFile', () => {
  it('classifies _tree.txt', () => {
    expect(classifySegmentFile('__next._tree.txt')).toBe('tree');
  });

  it('classifies _head.txt', () => {
    expect(classifySegmentFile('__next._head.txt')).toBe('head');
  });

  it('classifies _full.txt', () => {
    expect(classifySegmentFile('__next._full.txt')).toBe('full');
  });

  it('classifies __PAGE__ files', () => {
    expect(classifySegmentFile('__next.product.$d$id.__PAGE__.txt')).toBe('page');
  });

  it('classifies layout segments as shared', () => {
    expect(classifySegmentFile('__next._index.txt')).toBe('shared');
    expect(classifySegmentFile('__next.product.txt')).toBe('shared');
    expect(classifySegmentFile('__next.product.$d$id.txt')).toBe('shared');
  });
});

describe('patchTreeSegment', () => {
  // Single-param tree
  const singleTemplate = '0:{"buildId":"abc","tree":{"name":"","paramType":null,"paramKey":"","slots":{"children":{"name":"product","paramType":null,"paramKey":"product","slots":{"children":{"name":"id","paramType":"d","paramKey":"1","slots":{"children":{"name":"__PAGE__","paramType":null,"paramKey":"__PAGE__","slots":null}}}}}}}}';

  it('replaces the dynamic paramKey value (single param)', () => {
    const result = patchTreeSegment(singleTemplate, { id: '42' });
    expect(result).toContain('"name":"id","paramType":"d","paramKey":"42"');
    expect(result).not.toContain('"paramKey":"1"');
  });

  it('preserves other paramKey values (single param)', () => {
    const result = patchTreeSegment(singleTemplate, { id: '42' });
    expect(result).toContain('"paramKey":"product"');
    expect(result).toContain('"paramKey":"__PAGE__"');
  });

  it('handles slug-style values', () => {
    const result = patchTreeSegment(singleTemplate, { id: 'my-awesome-product' });
    expect(result).toContain('"name":"id","paramType":"d","paramKey":"my-awesome-product"');
  });

  // Multi-param tree
  const multiTemplate = '0:{"buildId":"abc","tree":{"name":"","paramType":null,"paramKey":"","slots":{"children":{"name":"lang","paramType":"d","paramKey":"en","slots":{"children":{"name":"products","paramType":null,"paramKey":"products","slots":{"children":{"name":"id","paramType":"d","paramKey":"1","slots":{"children":{"name":"__PAGE__","paramType":null,"paramKey":"__PAGE__","slots":null}}}}}}}}}}';

  it('patches both dynamic params (multi-param)', () => {
    const result = patchTreeSegment(multiTemplate, { lang: 'fr', id: '42' });
    expect(result).toContain('"name":"lang","paramType":"d","paramKey":"fr"');
    expect(result).toContain('"name":"id","paramType":"d","paramKey":"42"');
  });

  it('preserves static segments in multi-param tree', () => {
    const result = patchTreeSegment(multiTemplate, { lang: 'da', id: '99' });
    expect(result).toContain('"paramKey":"products"');
    expect(result).toContain('"paramKey":"__PAGE__"');
    expect(result).not.toContain('"paramKey":"en"');
    expect(result).not.toContain('"paramKey":"1"');
  });
});

describe('patchPageSegment', () => {
  const template = `1:"$Sreact.fragment"
2:I[71446,["/_next/static/chunks/abc.js"],"ProductDetail"]
0:{"buildId":"abc","rsc":["$","$1","c",{"children":[["$","$L2",null,{"id":"1"}],["$","script","script-0",{"src":"test.js"}]]}],"loading":null,"isPartial":false}`;

  it('replaces param value in page component props', () => {
    const result = patchPageSegment(template, { id: '42' });
    expect(result).toContain('{"id":"42"}');
    expect(result).not.toContain('{"id":"1"}');
  });

  it('handles multiple params', () => {
    const multiTemplate = '0:{"rsc":["$","$L2",null,{"year":"2024","slug":"my-post"}]}';
    const result = patchPageSegment(multiTemplate, { year: '2025', slug: 'new-post' });
    expect(result).toContain('"year":"2025"');
    expect(result).toContain('"slug":"new-post"');
  });

  it('preserves non-param content', () => {
    const result = patchPageSegment(template, { id: '42' });
    expect(result).toContain('ProductDetail');
    expect(result).toContain('"buildId":"abc"');
  });
});
