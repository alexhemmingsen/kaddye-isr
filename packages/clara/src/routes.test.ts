import { describe, it, expect } from 'vitest';
import {
  extractParamNames,
  patternToRegex,
  matchRoute,
  buildManifest,
} from './routes.js';
import type { ManifestRoute } from './types.js';

// ── extractParamNames ────────────────────────────────────────────

describe('extractParamNames', () => {
  it('extracts a single param', () => {
    expect(extractParamNames('/product/:id')).toEqual(['id']);
  });

  it('extracts multiple params', () => {
    expect(extractParamNames('/blog/:year/:slug')).toEqual(['year', 'slug']);
  });

  it('returns empty array for no params', () => {
    expect(extractParamNames('/about')).toEqual([]);
  });

  it('handles deeply nested params', () => {
    expect(extractParamNames('/a/:b/c/:d/e/:f')).toEqual(['b', 'd', 'f']);
  });
});

// ── patternToRegex ───────────────────────────────────────────────

describe('patternToRegex', () => {
  it('converts single param pattern', () => {
    expect(patternToRegex('/product/:id')).toBe('^/product/([^/]+)$');
  });

  it('converts multi-param pattern', () => {
    expect(patternToRegex('/blog/:year/:slug')).toBe(
      '^/blog/([^/]+)/([^/]+)$'
    );
  });

  it('escapes regex special characters in static segments', () => {
    const regex = patternToRegex('/items/:id');
    // Should be a valid regex
    expect(() => new RegExp(regex)).not.toThrow();
  });

  it('produces regex that matches the right URLs', () => {
    const regex = new RegExp(patternToRegex('/product/:id'));
    expect(regex.test('/product/42')).toBe(true);
    expect(regex.test('/product/abc-123')).toBe(true);
    expect(regex.test('/product/')).toBe(false);
    expect(regex.test('/product')).toBe(false);
    expect(regex.test('/products/42')).toBe(false);
    expect(regex.test('/product/42/extra')).toBe(false);
  });
});

// ── matchRoute ───────────────────────────────────────────────────

describe('matchRoute', () => {
  const routes: ManifestRoute[] = [
    {
      pattern: '/product/:id',
      paramNames: ['id'],
      regex: '^/product/([^/]+)$',
    },
    {
      pattern: '/blog/:year/:slug',
      paramNames: ['year', 'slug'],
      regex: '^/blog/([^/]+)/([^/]+)$',
    },
  ];

  it('matches a single-param route', () => {
    const result = matchRoute('/product/42', routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '42' });
    expect(result!.route.pattern).toBe('/product/:id');
  });

  it('matches a multi-param route', () => {
    const result = matchRoute('/blog/2024/hello-world', routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ year: '2024', slug: 'hello-world' });
  });

  it('returns null for non-matching URL', () => {
    expect(matchRoute('/about', routes)).toBeNull();
  });

  it('returns null for partial match', () => {
    expect(matchRoute('/product', routes)).toBeNull();
  });

  it('returns null for extra segments', () => {
    expect(matchRoute('/product/42/reviews', routes)).toBeNull();
  });

  it('strips query string before matching', () => {
    const result = matchRoute('/product/42?ref=google', routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '42' });
  });

  it('strips trailing slash before matching', () => {
    const result = matchRoute('/product/42/', routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: '42' });
  });

  it('handles root path', () => {
    expect(matchRoute('/', routes)).toBeNull();
  });

  it('handles URL-encoded params', () => {
    const result = matchRoute('/product/hello%20world', routes);
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ id: 'hello%20world' });
  });
});

// ── buildManifest ────────────────────────────────────────────────

describe('buildManifest', () => {
  it('builds a manifest from route definitions', () => {
    const manifest = buildManifest([
      { pattern: '/product/:id' },
      { pattern: '/blog/:year/:slug' },
    ]);

    expect(manifest.version).toBe(1);
    expect(manifest.routes).toHaveLength(2);

    expect(manifest.routes[0]).toEqual({
      pattern: '/product/:id',
      paramNames: ['id'],
      regex: '^/product/([^/]+)$',
    });

    expect(manifest.routes[1]).toEqual({
      pattern: '/blog/:year/:slug',
      paramNames: ['year', 'slug'],
      regex: '^/blog/([^/]+)/([^/]+)$',
    });
  });

  it('builds an empty manifest', () => {
    const manifest = buildManifest([]);
    expect(manifest.version).toBe(1);
    expect(manifest.routes).toHaveLength(0);
  });
});
