import type { QlaraRoute, QlaraManifest, ManifestRoute, RouteMatch } from './types.js';

/**
 * Extract parameter names from a route pattern.
 * '/product/:id' → ['id']
 * '/blog/:year/:slug' → ['year', 'slug']
 */
export function extractParamNames(pattern: string): string[] {
  const matches = pattern.match(/:([^/]+)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

/**
 * Convert a route pattern to a regex string.
 * '/product/:id' → '^/product/([^/]+)$'
 * '/blog/:year/:slug' → '^/blog/([^/]+)/([^/]+)$'
 */
export function patternToRegex(pattern: string): string {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/:([^/]+)/g, '([^/]+)');
  return `^${withParams}$`;
}

/**
 * Match a URL against a list of manifest routes.
 * Returns the matched route and extracted params, or null.
 */
export function matchRoute(url: string, routes: ManifestRoute[]): RouteMatch | null {
  // Strip query string and trailing slash for matching
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

/**
 * Build a manifest from route definitions.
 */
export function buildManifest(routes: QlaraRoute[]): QlaraManifest {
  return {
    version: 1,
    routes: routes.map((route) => ({
      pattern: route.pattern,
      paramNames: extractParamNames(route.pattern),
      regex: patternToRegex(route.pattern),
    })),
  };
}
