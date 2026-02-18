/**
 * Tests for the Lambda@Edge origin-request handler logic.
 *
 * The actual edge-handler.ts uses injected globals (__QLARA_BUCKET_NAME__, etc.)
 * and module-level AWS SDK clients, making it hard to unit test directly.
 *
 * Instead, we test the handler's decision logic by reimplementing the core flow
 * with injectable dependencies — same logic, testable structure.
 *
 * Key behavior: the handler NEVER generates responses. It always forwards
 * the request to S3 origin. The only question is whether the renderer is
 * invoked first (to ensure the file exists in S3).
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
// Models the origin-request flow:
// 1. Non-HTML → forward to origin
// 2. Check S3 (HEAD) → if file exists, forward to origin
// 3. If missing + route matches → invoke renderer → forward to origin
// 4. Always forward to origin

interface Deps {
  getManifest: () => Promise<{ version: 1; routes: ManifestRoute[] } | null>;
  fileExistsInS3: (key: string) => Promise<boolean>;
  invokeRenderer: (uri: string, match: RouteMatch) => Promise<void>;
}

interface CloudFrontRequestEvent {
  uri: string;
}

interface HandlerResult {
  action: 'forward-to-origin';
  rendererInvoked: boolean;
}

async function handleEdgeRequest(event: CloudFrontRequestEvent, deps: Deps): Promise<HandlerResult> {
  const { uri } = event;

  // 1. Non-HTML files → forward to origin
  const nonHtmlExt = uri.match(/\.([a-z0-9]+)$/)?.[1];
  if (nonHtmlExt && nonHtmlExt !== 'html') {
    return { action: 'forward-to-origin', rendererInvoked: false };
  }

  // 2. Check S3 for file existence
  const s3Key = uri.replace(/^\//, '');
  let fileExists = false;
  if (s3Key) {
    fileExists = await deps.fileExistsInS3(s3Key);
  }

  // 3. File exists → forward to origin (no renderer needed)
  if (fileExists) {
    return { action: 'forward-to-origin', rendererInvoked: false };
  }

  // 4. File missing → check manifest
  const cleanUri = uri.replace(/\.html$/, '');
  const manifest = await deps.getManifest();
  const match = manifest ? matchRoute(cleanUri, manifest.routes) : null;

  if (match) {
    // 5. Invoke renderer (uploads to S3)
    await deps.invokeRenderer(cleanUri, match);
    return { action: 'forward-to-origin', rendererInvoked: true };
  }

  // 6. No match → forward to origin (S3 will return 403/404)
  return { action: 'forward-to-origin', rendererInvoked: false };
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

describe('edge handler logic (origin-request, forward-only)', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = {
      getManifest: vi.fn().mockResolvedValue(MANIFEST),
      fileExistsInS3: vi.fn().mockResolvedValue(false), // Default: file doesn't exist
      invokeRenderer: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ── All results are forward-to-origin ─────────────────────────

  it('always returns forward-to-origin', async () => {
    const result = await handleEdgeRequest({ uri: '/product/42.html' }, deps);
    expect(result.action).toBe('forward-to-origin');
  });

  // ── Non-HTML files → forward without any checks ────────────────

  it('forwards non-HTML files without checking S3', async () => {
    const result = await handleEdgeRequest({ uri: '/product/20.txt' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
    expect(deps.fileExistsInS3).not.toHaveBeenCalled();
    expect(deps.getManifest).not.toHaveBeenCalled();
  });

  it('forwards .json files without any checks', async () => {
    const result = await handleEdgeRequest({ uri: '/data/products.json' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
    expect(deps.fileExistsInS3).not.toHaveBeenCalled();
  });

  it('forwards JS files without any checks', async () => {
    const result = await handleEdgeRequest({ uri: '/_next/static/chunks/main.js' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
  });

  it('forwards CSS files without any checks', async () => {
    const result = await handleEdgeRequest({ uri: '/_next/static/css/style.css' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
  });

  it('forwards image files without any checks', async () => {
    const result = await handleEdgeRequest({ uri: '/images/logo.png' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
  });

  // ── File exists in S3 → no renderer ─────────────────────────────

  it('does not invoke renderer when file exists in S3', async () => {
    deps.fileExistsInS3 = vi.fn().mockResolvedValue(true);

    const result = await handleEdgeRequest({ uri: '/product/1.html' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
    expect(deps.getManifest).not.toHaveBeenCalled();
  });

  it('checks S3 with correct key (strips leading slash)', async () => {
    deps.fileExistsInS3 = vi.fn().mockResolvedValue(true);

    await handleEdgeRequest({ uri: '/product/42.html' }, deps);

    expect(deps.fileExistsInS3).toHaveBeenCalledWith('product/42.html');
  });

  it('does not invoke renderer for existing index.html', async () => {
    deps.fileExistsInS3 = vi.fn().mockResolvedValue(true);

    const result = await handleEdgeRequest({ uri: '/index.html' }, deps);

    expect(result.rendererInvoked).toBe(false);
  });

  // ── File missing + route matches → renderer invoked ─────────────

  it('invokes renderer for matching route when file missing', async () => {
    const result = await handleEdgeRequest({ uri: '/product/42.html' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(true);
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/product/42',
      expect.objectContaining({
        route: expect.objectContaining({ pattern: '/product/:id' }),
        params: { id: '42' },
      })
    );
  });

  it('invokes renderer for multi-param routes', async () => {
    const result = await handleEdgeRequest({ uri: '/blog/2024/my-post.html' }, deps);

    expect(result.rendererInvoked).toBe(true);
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/blog/2024/my-post',
      expect.objectContaining({
        params: { year: '2024', slug: 'my-post' },
      })
    );
  });

  it('strips .html before route matching', async () => {
    await handleEdgeRequest({ uri: '/product/42.html' }, deps);

    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/product/42',
      expect.objectContaining({
        params: { id: '42' },
      })
    );
  });

  // ── File missing + no route match → no renderer ─────────────────

  it('does not invoke renderer for non-matching paths', async () => {
    const result = await handleEdgeRequest({ uri: '/about.html' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('does not invoke renderer for deeply nested non-matching paths', async () => {
    const result = await handleEdgeRequest({ uri: '/user/123/settings.html' }, deps);

    expect(result.rendererInvoked).toBe(false);
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  // ── Manifest errors ─────────────────────────────────────────────

  it('does not invoke renderer if manifest fetch fails', async () => {
    deps.getManifest = vi.fn().mockResolvedValue(null);

    const result = await handleEdgeRequest({ uri: '/product/42.html' }, deps);

    expect(result.action).toBe('forward-to-origin');
    expect(result.rendererInvoked).toBe(false);
  });

  // ── Only dynamic route triggers renderer ────────────────────────

  it('only invokes renderer for the specific dynamic route that was requested', async () => {
    // Request /product/23 — only this route should trigger the renderer
    await handleEdgeRequest({ uri: '/product/23.html' }, deps);

    expect(deps.invokeRenderer).toHaveBeenCalledTimes(1);
    expect(deps.invokeRenderer).toHaveBeenCalledWith(
      '/product/23',
      expect.objectContaining({ params: { id: '23' } })
    );
  });

  it('does not invoke renderer for /product list page', async () => {
    // /product.html does NOT match /product/:id (no param segment)
    const result = await handleEdgeRequest({ uri: '/product.html' }, deps);

    expect(result.rendererInvoked).toBe(false);
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });

  it('does not invoke renderer for unrelated routes', async () => {
    const result = await handleEdgeRequest({ uri: '/blog/posts.html' }, deps);

    // /blog/posts does not match /blog/:year/:slug (only 1 segment after /blog/)
    expect(result.rendererInvoked).toBe(false);
    expect(deps.invokeRenderer).not.toHaveBeenCalled();
  });
});
