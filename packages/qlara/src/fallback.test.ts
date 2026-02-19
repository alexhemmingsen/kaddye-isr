/**
 * Tests for fallback generation, focusing on findTemplateForRoute
 * and generateFallbacks behavior with single-param and multi-param routes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findTemplateForRoute,
  generateFallbacks,
  getFallbackKey,
  paramPlaceholder,
  FALLBACK_FILENAME,
} from './fallback.js';

// ── Test fixture helpers ─────────────────────────────────────────

let testDir: string;

function createTestDir(): string {
  const dir = join(tmpdir(), `qlara-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFile(relativePath: string, content = '<html><title>Test</title></html>'): void {
  const fullPath = join(testDir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeEach(() => {
  testDir = createTestDir();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── findTemplateForRoute ─────────────────────────────────────────

describe('findTemplateForRoute', () => {
  it('single-param: finds template in static directory', () => {
    createFile('product/1.html');
    createFile('product/2.html');

    const result = findTemplateForRoute(testDir, '/product/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/product\/\d+\.html$/);
  });

  it('multi-param: finds template across dynamic directories', () => {
    createFile('da/products/29.html');

    const result = findTemplateForRoute(testDir, '/:lang/products/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/da\/products\/29\.html$/);
  });

  it('multi-param: tries multiple dynamic directories', () => {
    // Only 'en' has products
    createFile('en/products/1.html');
    mkdirSync(join(testDir, 'da/products'), { recursive: true });
    // da/products has no html files

    const result = findTemplateForRoute(testDir, '/:lang/products/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/en\/products\/1\.html$/);
  });

  it('all-dynamic: finds template in nested dynamic dirs', () => {
    createFile('en/42.html');

    const result = findTemplateForRoute(testDir, '/:lang/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/en\/42\.html$/);
  });

  it('triple-param with mixed static/dynamic', () => {
    createFile('en/shop/electronics/items/1.html');

    const result = findTemplateForRoute(testDir, '/:lang/shop/:category/items/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/en\/shop\/electronics\/items\/1\.html$/);
  });

  it('returns null when no matching files exist', () => {
    mkdirSync(join(testDir, 'da'), { recursive: true });
    // No html files anywhere

    const result = findTemplateForRoute(testDir, '/:lang/products/:id');
    expect(result).toBeNull();
  });

  it('returns null when build dir does not exist', () => {
    const result = findTemplateForRoute('/nonexistent/path', '/product/:id');
    expect(result).toBeNull();
  });

  it('skips _next directories', () => {
    createFile('_next/data/1.html');
    createFile('en/products/1.html');

    const result = findTemplateForRoute(testDir, '/:lang/products/:id');
    expect(result).not.toBeNull();
    expect(result).toMatch(/en\/products\/1\.html$/);
    expect(result).not.toMatch(/_next/);
  });

  it('skips hidden directories', () => {
    createFile('.hidden/products/1.html');
    createFile('en/products/1.html');

    const result = findTemplateForRoute(testDir, '/:lang/products/:id');
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/\.hidden/);
  });

  it('skips _fallback.html when looking for templates', () => {
    createFile('product/_fallback.html');
    // No other html files

    const result = findTemplateForRoute(testDir, '/product/:id');
    expect(result).toBeNull();
  });
});

// ── generateFallbacks ────────────────────────────────────────────

describe('generateFallbacks', () => {
  const sampleHtml = '<html><head><title>Product 1</title></head><body><main><div>Content</div></main></body></html>';

  it('single-param: generates fallback in static directory', () => {
    createFile('product/1.html', sampleHtml);

    const result = generateFallbacks(testDir, [{ pattern: '/product/:id' }]);

    expect(result).toEqual([join('product', FALLBACK_FILENAME)]);
    expect(existsSync(join(testDir, 'product', FALLBACK_FILENAME))).toBe(true);
  });

  it('multi-param: generates fallback in static-only directory', () => {
    createFile('da/products/29.html', sampleHtml);

    const result = generateFallbacks(testDir, [{ pattern: '/:lang/products/:id' }]);

    expect(result).toEqual([join('products', FALLBACK_FILENAME)]);
    expect(existsSync(join(testDir, 'products', FALLBACK_FILENAME))).toBe(true);
  });

  it('multi-param: creates output directory if it does not exist', () => {
    createFile('da/products/29.html', sampleHtml);
    // 'products/' directory doesn't exist in testDir root

    expect(existsSync(join(testDir, 'products'))).toBe(false);

    generateFallbacks(testDir, [{ pattern: '/:lang/products/:id' }]);

    expect(existsSync(join(testDir, 'products', FALLBACK_FILENAME))).toBe(true);
  });

  it('all-dynamic: generates fallback at root', () => {
    createFile('en/42.html', sampleHtml);

    const result = generateFallbacks(testDir, [{ pattern: '/:lang/:id' }]);

    expect(result).toEqual([FALLBACK_FILENAME]);
    expect(existsSync(join(testDir, FALLBACK_FILENAME))).toBe(true);
  });

  it('skips route with no matching template', () => {
    // No files at all
    const result = generateFallbacks(testDir, [{ pattern: '/:lang/products/:id' }]);

    expect(result).toEqual([]);
  });

  it('handles multiple routes', () => {
    createFile('product/1.html', sampleHtml);
    createFile('da/blog/post-1.html', sampleHtml);

    const result = generateFallbacks(testDir, [
      { pattern: '/product/:id' },
      { pattern: '/:lang/blog/:slug' },
    ]);

    expect(result).toHaveLength(2);
    expect(existsSync(join(testDir, 'product', FALLBACK_FILENAME))).toBe(true);
    expect(existsSync(join(testDir, 'blog', FALLBACK_FILENAME))).toBe(true);
  });

  it('fallback contains per-param placeholders', () => {
    const html = '<html><head><title>Test</title></head><body><main><div>Content</div></main></body></html>';
    createFile('da/products/29.html', html);

    generateFallbacks(testDir, [{ pattern: '/:lang/products/:id' }]);

    const fallback = readFileSync(join(testDir, 'products', FALLBACK_FILENAME), 'utf-8');
    expect(fallback).toContain('Loading...');
  });
});

// ── getFallbackKey ────────────────────────────────────────────────

describe('getFallbackKey', () => {
  it('single-param', () => {
    expect(getFallbackKey('/product/:id')).toBe(`product/${FALLBACK_FILENAME}`);
  });

  it('multi-param', () => {
    expect(getFallbackKey('/:lang/products/:id')).toBe(`products/${FALLBACK_FILENAME}`);
  });

  it('all dynamic', () => {
    expect(getFallbackKey('/:a/:b/:c')).toBe(FALLBACK_FILENAME);
  });

  it('mixed static and dynamic', () => {
    expect(getFallbackKey('/:lang/shop/:category/items/:id')).toBe(`shop/items/${FALLBACK_FILENAME}`);
  });
});

// ── paramPlaceholder ─────────────────────────────────────────────

describe('paramPlaceholder', () => {
  it('generates per-param placeholder', () => {
    expect(paramPlaceholder('id')).toBe('__QLARA_FALLBACK_id__');
    expect(paramPlaceholder('lang')).toBe('__QLARA_FALLBACK_lang__');
  });
});
