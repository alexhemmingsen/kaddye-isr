/**
 * Fallback page generator for Clara.
 *
 * At deploy time, for each dynamic route defined in the Clara config,
 * this module finds an existing statically generated page and creates
 * a "fallback" version from it.
 *
 * The fallback page:
 * - Shares the same JS chunks as real pages (so React hydration works)
 * - Has the `__CLARA_FALLBACK__` placeholder where the route param would be
 * - Has generic "Loading..." metadata
 * - Triggers client-side data fetching instead of showing stale server data
 *
 * At runtime, Clara's edge handler:
 * 1. Reads the fallback from S3
 * 2. Replaces `__CLARA_FALLBACK__` with the actual param value from the URL
 * 3. Serves it to the user (who sees a loading state, then real content)
 * 4. Fires off the renderer to generate and cache the real page with SEO metadata
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaraRoute } from './types.js';

export const FALLBACK_FILENAME = '_fallback.html';
export const FALLBACK_PLACEHOLDER = '__CLARA_FALLBACK__';

/**
 * Generate a fallback HTML page from an existing statically generated page.
 *
 * Strips product-specific content and metadata, replacing with loading state.
 * Inserts `__CLARA_FALLBACK__` placeholder where route params appear in RSC flight data.
 */
export function generateFallbackFromTemplate(
  templateHtml: string,
  routePattern: string
): string {
  let fallback = templateHtml;

  // Extract param names from route pattern: '/product/:id' → ['id']
  const paramNames = (routePattern.match(/:([^/]+)/g) || []).map(m => m.slice(1));

  // 1. Replace <title> with a generic loading title
  fallback = fallback.replace(
    /<title>[^<]*<\/title>/,
    '<title>Loading...</title>'
  );

  // 2. Remove all Clara-managed meta and link tags.
  //    The renderer will inject the correct ones at render time.
  //    Match meta tags with name= or property= for all Clara-managed prefixes.
  fallback = fallback.replace(/<meta\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s+content="[^"]*"\s*\/?>/g, '');
  //    Also match content-first ordering
  fallback = fallback.replace(/<meta\s+content="[^"]*"\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s*\/?>/g, '');
  //    Link tags that Clara manages
  fallback = fallback.replace(/<link\s+rel="(?:canonical|alternate|author|icon|shortcut icon|apple-touch-icon|apple-touch-startup-image|manifest|archives|assets|bookmarks|prev|next)"[^>]*\/?>/g, '');

  // 3. Replace server-rendered body content between <main> tags with loading state
  fallback = fallback.replace(
    /(<main[^>]*>)[\s\S]*?(<\/main>)/,
    '$1<div>Loading...</div>$2'
  );

  // 4. Patch RSC flight data — replace specific param values with placeholder
  //
  // IMPORTANT: RSC flight data is embedded inside <script> tags as a JSON string
  // within self.__next_f.push([1,"..."]), so double quotes appear as \" in the HTML.
  // We need to match the escaped form: {\"id\":\"1\"} not {"id":"1"}

  // Helper: escaped double quote in RSC flight data
  const q = '\\\\"'; // matches literal \" in the HTML string

  // Patch the component props: {\"id\":\"X\"} → {\"id\":\"__CLARA_FALLBACK__\"}
  for (const param of paramNames) {
    // Match {\"id\":\"VALUE\"} with optional ,\"initial\":... suffix
    const propsRegex = new RegExp(
      `\\{${q}${param}${q}:${q}[^"]+?${q}(,${q}initial${q}:(null|\\{[^}]*\\}))?\\}`,
      'g'
    );
    fallback = fallback.replace(
      propsRegex,
      `{\\"${param}\\":\\"${FALLBACK_PLACEHOLDER}\\"}`
    );
  }

  // Patch route segment: [\"id\",\"X\",\"d\"] → [\"id\",\"__CLARA_FALLBACK__\",\"d\"]
  for (const param of paramNames) {
    const segmentRegex = new RegExp(
      `\\[${q}${param}${q},${q}[^"]+${q},${q}d${q}\\]`,
      'g'
    );
    fallback = fallback.replace(
      segmentRegex,
      `[\\"${param}\\",\\"${FALLBACK_PLACEHOLDER}\\",\\"d\\"]`
    );
  }

  // Patch URL segments in flight data:
  // \"c\":[\"\",\"product\",\"X\"] → \"c\":[\"\",\"product\",\"__CLARA_FALLBACK__\"]
  const routeParts = routePattern.split('/').filter(p => !p.startsWith(':'));
  if (routeParts.length > 0) {
    const prefix = routeParts.map(p => `${q}${p}${q}`).join(',');
    const urlSegmentRegex = new RegExp(
      `(${q}c${q}:\\[${prefix},)${q}[^"]*${q}\\]`,
      'g'
    );
    fallback = fallback.replace(
      urlSegmentRegex,
      `$1\\"${FALLBACK_PLACEHOLDER}\\"]`
    );
  }

  // 5. Replace metadata flight data with generic loading metadata
  //    RSC flight data uses \" (backslash-quote) inside <script> tags
  //    Match: 8:{\"metadata\":[[...]],\"error\":null,\"digest\":\"$undefined\"}
  fallback = fallback.replace(
    /8:\{\\"metadata\\":\[[\s\S]*?\],\\"error\\":null,\\"digest\\":\\"?\$undefined\\?"\}/,
    '8:{\\"metadata\\":[[\\"$\\",\\"title\\",\\"0\\",{\\"children\\":\\"Loading...\\"}]],\\"error\\":null,\\"digest\\":\\"$undefined\\"}'
  );

  return fallback;
}

/**
 * Derive the S3 key prefix for a route's fallback.
 * '/product/:id' → 'product/_fallback.html'
 * '/blog/:year/:slug' → 'blog/_fallback.html'
 */
export function getFallbackKey(routePattern: string): string {
  const parts = routePattern.replace(/^\//, '').split('/');
  const dirParts = parts.filter(p => !p.startsWith(':'));
  return [...dirParts, FALLBACK_FILENAME].join('/');
}

/**
 * Generate fallback pages for all Clara dynamic routes.
 * Called during `clara deploy` before uploading to S3.
 *
 * @param buildDir - The build output directory (e.g., 'out')
 * @param routes - The Clara route definitions
 * @returns Array of generated fallback file paths (relative to buildDir)
 */
export function generateFallbacks(
  buildDir: string,
  routes: ClaraRoute[]
): string[] {
  const generated: string[] = [];

  for (const route of routes) {
    // Convert route pattern to directory path: '/product/:id' → 'product'
    const parts = route.pattern.replace(/^\//, '').split('/');
    const dirParts = parts.filter(p => !p.startsWith(':'));
    const routeDir = join(buildDir, ...dirParts);

    if (!existsSync(routeDir)) {
      console.warn(
        `[clara] Warning: No output directory for route ${route.pattern} at ${routeDir}`
      );
      continue;
    }

    // Find an existing .html file to use as template (skip _fallback.html itself)
    const files = readdirSync(routeDir).filter(
      f => f.endsWith('.html') && f !== FALLBACK_FILENAME
    );

    if (files.length === 0) {
      console.warn(
        `[clara] Warning: No HTML files in ${routeDir} to create fallback template`
      );
      continue;
    }

    const templatePath = join(routeDir, files[0]);
    const templateHtml = readFileSync(templatePath, 'utf-8');
    const fallbackHtml = generateFallbackFromTemplate(templateHtml, route.pattern);

    const fallbackPath = join(routeDir, FALLBACK_FILENAME);
    writeFileSync(fallbackPath, fallbackHtml);

    const relativePath = join(...dirParts, FALLBACK_FILENAME);
    generated.push(relativePath);
    console.log(`[clara] Generated fallback: ${relativePath}`);
  }

  return generated;
}
