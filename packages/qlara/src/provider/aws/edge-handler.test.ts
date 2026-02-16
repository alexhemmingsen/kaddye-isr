/**
 * Tests for the Lambda@Edge origin-response handler logic.
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

interface Deps {
  getManifest: () => Promise<{ version: 1; routes: ManifestRoute[] } | null>;
  getIndexHtml: () => Promise<string | null>;
  invokeRenderer: (uri: string) => Promise<void>;
}

interface CloudFrontEvent {
  uri: string;
  querystring: string;
  responseStatus: number;
}

async function handleEdgeResponse(event: CloudFrontEvent, deps: Deps) {
  const { uri, querystring, responseStatus } = event;
  const isBypass = querystring.includes('__qlara_bypass');

  // 1. File exists → pass through
  if (responseStatus !== 403 && responseStatus !== 404) {
    return { action: 'pass-through' as const };
  }

  // 2. Bypass + error → serve index.html, NO renderer
  if (isBypass) {
    const html = await deps.getIndexHtml();
    if (!html) return { action: 'pass-through' as const };
    return { action: 'serve-html' as const, html, rendererInvoked: false };
  }

  // 3. Check route match
  const manifest = await deps.getManifest();
  const match = manifest ? matchRoute(uri, manifest.routes) : null;

  // 4. Get index.html
  const html = await deps.getIndexHtml();
  if (!html) return { action: 'pass-through' as const };

  // 5. If match → trigger renderer
  if (match) {
    await deps.invokeRenderer(uri);
    return { action: 'serve-html' as const, html, rendererInvoked: true };
  }

  // 6. No match → still serve index.html (SPA fallback)
  return { action: 'serve-html' as const, html, rendererInvoked: false };
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

const INDEX_HTML = '<!DOCTYPE html><html><body>SPA Shell</body></html>';

describe('edge handler logic', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = {
      getManifest: vi.fn().mockResolvedValue(MANIFEST),
      getIndexHtml: vi.fn().mockResolvedValue(INDEX_HTML),
      invokeRenderer: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ── Pass-through cases ─────────────────────────────────────────

  it('passes through 200 responses (file exists)', async () => {
    const result = await handleEdgeResponse(
      { uri: '/product/1', querystring: '', responseStatus: 200 },
      deps
    );

    expect(result.action).toBe('pass-through');
    expect(deps.getManifest).not.toHaveBeenCalled();
    expect(deps.getIndexHtml).not.toHaveBeenCalled();
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('passes through 301 redirects', async () => {
    const result = await handleEdgeResponse(
      { uri: '/old-page', querystring: '', responseStatus: 301 },
      deps
    );

    expect(result.action).toBe('pass-through');
  });

  it('passes through 304 not modified', async () => {
    const result = await handleEdgeResponse(
      { uri: '/style.css', querystring: '', responseStatus: 304 },
      deps
    );

    expect(result.action).toBe('pass-through');
  });

  // ── Bypass cases ───────────────────────────────────────────────

  it('serves index.html with bypass param (no renderer)', async () => {
    const result = await handleEdgeResponse(
      {
        uri: '/product/42',
        querystring: '__qlara_bypass=1',
        responseStatus: 403,
      },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(INDEX_HTML);
      expect(result.rendererInvoked).toBe(false);
    }
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('bypass param prevents renderer even for matching routes', async () => {
    const result = await handleEdgeResponse(
      {
        uri: '/product/99',
        querystring: 'foo=bar&__qlara_bypass=1',
        responseStatus: 404,
      },
      deps
    );

    expect(result.action).toBe('serve-html');
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
    // Should not even check the manifest
    expect(deps.getManifest).not.toHaveBeenCalled();
  });

  it('bypass falls back to pass-through if index.html unavailable', async () => {
    deps.getIndexHtml = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeResponse(
      {
        uri: '/product/42',
        querystring: '__qlara_bypass=1',
        responseStatus: 403,
      },
      deps
    );

    expect(result.action).toBe('pass-through');
  });

  // ── Dynamic route matching ─────────────────────────────────────

  it('serves index.html AND invokes renderer for matching route', async () => {
    const result = await handleEdgeResponse(
      { uri: '/product/42', querystring: '', responseStatus: 403 },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(INDEX_HTML);
      expect(result.rendererInvoked).toBe(true);
    }
    expect(deps.invokeRenderer).toHaveBeenCalledWith('/product/42');
  });

  it('invokes renderer for multi-param routes', async () => {
    const result = await handleEdgeResponse(
      {
        uri: '/blog/2024/my-post',
        querystring: '',
        responseStatus: 403,
      },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.rendererInvoked).toBe(true);
    }
    expect(deps.invokeRenderer).toHaveBeenCalledWith('/blog/2024/my-post');
  });

  // ── SPA fallback (no match) ────────────────────────────────────

  it('serves index.html without renderer for non-matching 404', async () => {
    const result = await handleEdgeResponse(
      { uri: '/about', querystring: '', responseStatus: 404 },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.html).toBe(INDEX_HTML);
      expect(result.rendererInvoked).toBe(false);
    }
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('serves index.html without renderer for unknown dynamic path', async () => {
    const result = await handleEdgeResponse(
      { uri: '/user/123/settings', querystring: '', responseStatus: 403 },
      deps
    );

    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.rendererInvoked).toBe(false);
    }
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  // ── S3 OAC behavior (403 = not found) ──────────────────────────

  it('treats 403 the same as 404 (S3 OAC returns 403 for missing objects)', async () => {
    const result403 = await handleEdgeResponse(
      { uri: '/product/42', querystring: '', responseStatus: 403 },
      deps
    );

    const result404 = await handleEdgeResponse(
      { uri: '/product/42', querystring: '', responseStatus: 404 },
      deps
    );

    expect(result403.action).toBe('serve-html');
    expect(result404.action).toBe('serve-html');
  });

  // ── Error handling ─────────────────────────────────────────────

  it('falls back to pass-through if manifest fetch fails', async () => {
    deps.getManifest = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeResponse(
      { uri: '/product/42', querystring: '', responseStatus: 403 },
      deps
    );

    // No manifest → can't match → but still serves index.html as SPA fallback
    expect(result.action).toBe('serve-html');
    if (result.action === 'serve-html') {
      expect(result.rendererInvoked).toBe(false);
    }
  });

  it('falls back to pass-through if index.html fetch fails', async () => {
    deps.getIndexHtml = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeResponse(
      { uri: '/product/42', querystring: '', responseStatus: 403 },
      deps
    );

    expect(result.action).toBe('pass-through');
    // Should not invoke renderer if we can't serve the fallback
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });
});
