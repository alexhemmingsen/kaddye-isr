/**
 * Tests for the Lambda@Edge origin-request handler logic.
 *
 * The actual edge-handler.ts uses injected globals (__QLARA_BUCKET_NAME__, etc.)
 * and module-level AWS SDK clients, making it hard to unit test directly.
 *
 * Instead, we test the handler's decision logic by reimplementing the core flow
 * with injectable dependencies — same logic, testable structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Inline the route matching logic (same as in edge-handler.ts) ─

interface ManifestRoute {
  pattern: string;
  paramNames: string[];
  regex: string;
}

interface RouteMatch {
  route: ManifestRoute;
  params: Record<string, string>;
}

function matchRoute(
  url: string,
  routes: ManifestRoute[]
): RouteMatch | null {
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

// ── Testable handler that accepts dependencies ───────────────────
// Models the new origin-request flow:
// 1. Non-HTML → forward to origin
// 2. Try S3 → if file exists, serve it
// 3. Check manifest → if route matches, invoke renderer
// 4. No match → forward to origin

interface Deps {
  getManifest: () => Promise<{ version: 1; routes: ManifestRoute[] } | null>;
  getS3Html: (key: string) => Promise<string | null>;
  getFallbackHtml: (route: ManifestRoute) => Promise<string | null>;
  invokeRenderer: (uri: string, match: RouteMatch) => Promise<string | null>;
}

interface CloudFrontRequestEvent {
  uri: string;
  querystring: string;
}

type HandlerResult =
  | { action: 'forward-to-origin' }
  | { action: 'serve-html'; html: string; source: 's3' | 'renderer' | 'fallback' };

async function handleEdgeRequest(event: CloudFrontRequestEvent, deps: Deps): Promise<HandlerResult> {
  const { uri } = event;

  // 1. Non-HTML files → forward to origin
  const nonHtmlExt = uri.match(/\.([a-z0-9]+)$/)?.[1];
  if (nonHtmlExt && nonHtmlExt !== 'html') {
    return { action: 'forward-to-origin' };
  }

  // 2. Try S3 for the file
  const s3Key = uri.replace(/^\//, '');
  if (s3Key) {
    const html = await deps.getS3Html(s3Key);
    if (html) {
      return { action: 'serve-html', html, source: 's3' };
    }
  }

  // 3. Check manifest for route match
  const cleanUri = uri.replace(/\.html$/, '');
  const manifest = await deps.getManifest();
  const match = manifest ? matchRoute(cleanUri, manifest.routes) : null;

  // 4. If match → invoke renderer
  if (match) {
    const renderedHtml = await deps.invokeRenderer(cleanUri, match);
    if (renderedHtml) {
      return { action: 'serve-html', html: renderedHtml, source: 'renderer' };
    }

    // Renderer failed → try fallback
    const fallbackHtml = await deps.getFallbackHtml(match.route);
    if (fallbackHtml) {
      return { action: 'serve-html', html: fallbackHtml, source: 'fallback' };
    }
  }

  // 5. No match → forward to origin
  return { action: 'forward-to-origin' };
}

// ── Tests ────────────────────────────────────────────────────────

const MANIFEST = {
  version: 1 as const,
  routes: [
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
  ],
};

const RENDERED_HTML = '<!DOCTYPE html><html><body>Rendered</body></html>';
const FALLBACK_HTML = '<!DOCTYPE html><html><body>Fallback</body></html>';
const S3_HTML = '<!DOCTYPE html><html><body>From S3</body></html>';

describe('edge handler logic (origin-request)', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = {
      getManifest: vi.fn().mockResolvedValue(MANIFEST),
      getS3Html: vi.fn().mockResolvedValue(null), // Default: file doesn't exist
      getFallbackHtml: vi.fn().mockResolvedValue(FALLBACK_HTML),
      invokeRenderer: vi.fn().mockResolvedValue(RENDERED_HTML),
    };
  });

  // ── Non-HTML files → forward to origin ─────────────────────────

  it('forwards non-HTML files to origin', async () => {
    const result = await handleEdgeRequest(
      { uri: '/product/20.txt', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
    expect(deps.getS3Html).not.toHaveBeenCalled();
    expect(deps.getManifest).not.toHaveBeenCalled();
  });

  it('forwards .json files to origin', async () => {
    const result = await handleEdgeRequest(
      { uri: '/data/products.json', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  it('forwards JS files to origin', async () => {
    const result = await handleEdgeRequest(
      { uri: '/_next/static/chunks/main.js', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  it('forwards CSS files to origin', async () => {
    const result = await handleEdgeRequest(
      { uri: '/_next/static/css/style.css', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  it('forwards image files to origin', async () => {
    const result = await handleEdgeRequest(
      { uri: '/images/logo.png', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  // ── S3 file exists → serve directly ─────────────────────────────

  it('serves HTML from S3 when file exists', async () => {
    deps.getS3Html = vi.fn().mockResolvedValue(S3_HTML);

    const result = await handleEdgeRequest(
      { uri: '/product/1.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(S3_HTML);
      expect(result.source).toBe('s3');
    }
    expect(deps.getManifest).not.toHaveBeenCalled();
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('serves index.html from S3', async () => {
    deps.getS3Html = vi.fn().mockResolvedValue(S3_HTML);

    const result = await handleEdgeRequest(
      { uri: '/index.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.source).toBe('s3');
    }
  });

  it('calls S3 with the correct key (strips leading slash)', async () => {
    deps.getS3Html = vi.fn().mockResolvedValue(null);

    await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    expect(deps.getS3Html).toHaveBeenCalledWith('product/42.html');
  });

  // ── Dynamic route matching → renderer ──────────────────────────

  it('invokes renderer for matching route when S3 file missing', async () => {
    const result = await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(RENDERED_HTML);
      expect(result.source).toBe('renderer');
    }
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/product/42',
      expect.objectContaining({
        route: expect.objectContaining({ pattern: '/product/:id' }),
        params: { id: '42' },
      })
    );
  });

  it('invokes renderer for multi-param routes', async () => {
    const result = await handleEdgeRequest(
      { uri: '/blog/2024/my-post.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.source).toBe('renderer');
    }
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/blog/2024/my-post',
      expect.objectContaining({
        params: { year: '2024', slug: 'my-post' },
      })
    );
  });

  // ── Renderer fails → fallback ──────────────────────────────────

  it('falls back to fallback HTML when renderer fails', async () => {
    deps.invokeRenderer = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(FALLBACK_HTML);
      expect(result.source).toBe('fallback');
    }
  });

  it('forwards to origin when renderer AND fallback fail', async () => {
    deps.invokeRenderer = vi.fn().mockResolvedValue(null);
    deps.getFallbackHtml = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  // ── No route match → forward to origin ──────────────────────────

  it('forwards to origin for non-matching paths', async () => {
    const result = await handleEdgeRequest(
      { uri: '/about.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('forwards to origin for deeply nested non-matching paths', async () => {
    const result = await handleEdgeRequest(
      { uri: '/user/123/settings.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  // ── Manifest errors ─────────────────────────────────────────────

  it('forwards to origin if manifest fetch fails', async () => {
    deps.getManifest = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('forward-to-origin');
  });

  // ── .html extension handling ────────────────────────────────────

  it('treats .html as HTML (not forwarded to origin)', async () => {
    deps.getS3Html = vi.fn().mockResolvedValue(S3_HTML);

    const result = await handleEdgeRequest(
      { uri: '/about.html', querystring: '' },
      deps
    );

    expect(result.action).toBe('serve-html');
  });

  it('strips .html before route matching', async () => {
    const result = await handleEdgeRequest(
      { uri: '/product/42.html', querystring: '' },
      deps
    );

    // Should match /product/:id with id=42, not id=42.html
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/product/42',
      expect.objectContaining({
        params: { id: '42' },
      })
    );
  });
});
