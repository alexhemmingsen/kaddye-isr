/**
 * Fallback page generator for Qlara.
 *
 * At deploy time, for each dynamic route defined in the Qlara config,
 * this module finds an existing statically generated page and creates
 * a "fallback" version from it.
 *
 * The fallback page:
 * - Shares the same JS chunks as real pages (so React hydration works)
 * - Has per-param placeholders (`__QLARA_FALLBACK_id__`, `__QLARA_FALLBACK_lang__`) where dynamic values would be
 * - Has generic "Loading..." metadata
 * - Triggers client-side data fetching instead of showing stale server data
 *
 * At runtime, Qlara's renderer:
 * 1. Reads the fallback from S3
 * 2. Replaces each per-param placeholder with the actual param value from the URL
 * 3. Patches metadata from the developer's generateMetadata function
 * 4. Uploads the final SEO-complete HTML to S3 for future requests
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { QlaraRoute } from './types.js';

export const FALLBACK_FILENAME = '_fallback.html';

/**
 * @deprecated Use `paramPlaceholder(name)` for per-param placeholders.
 * Kept for reference only — no longer used in generation/rendering logic.
 */
export const FALLBACK_PLACEHOLDER = '__QLARA_FALLBACK__';

/**
 * Generate a per-param placeholder string.
 * Each dynamic param gets a unique placeholder so the renderer can
 * replace them independently at runtime.
 *
 * paramPlaceholder('id')   → '__QLARA_FALLBACK_id__'
 * paramPlaceholder('lang') → '__QLARA_FALLBACK_lang__'
 */
export function paramPlaceholder(paramName: string): string {
  return `__QLARA_FALLBACK_${paramName}__`;
}

/**
 * Generate a fallback HTML page from an existing statically generated page.
 *
 * Strips page-specific content and metadata, replacing with loading state.
 * Inserts per-param placeholders (e.g. `__QLARA_FALLBACK_id__`) where route params appear in RSC flight data.
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

  // 2. Remove all Qlara-managed meta and link tags.
  //    The renderer will inject the correct ones at render time.
  //    Match meta tags with name= or property= for all Qlara-managed prefixes.
  fallback = fallback.replace(/<meta\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s+content="[^"]*"\s*\/?>/g, '');
  //    Also match content-first ordering
  fallback = fallback.replace(/<meta\s+content="[^"]*"\s+(?:name|property)="(?:description|application-name|generator|creator|publisher|category|classification|abstract|referrer|keywords|author|robots|googlebot|og:[^"]*|twitter:[^"]*|fb:[^"]*|al:[^"]*|google-site-verification|y_key|yandex-verification|me|apple-mobile-web-app-[^"]*|format-detection|apple-itunes-app|pinterest-rich-pin)"\s*\/?>/g, '');
  //    Link tags that Qlara manages
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

  // Patch the component props: {\"id\":\"X\"} → {\"id\":\"__QLARA_FALLBACK_id__\"}
  // Each param gets a unique per-param placeholder so the renderer can replace them independently.
  for (const param of paramNames) {
    // Match {\"id\":\"VALUE\"} with optional ,\"initial\":... suffix
    const propsRegex = new RegExp(
      `\\{${q}${param}${q}:${q}[^"]+?${q}(,${q}initial${q}:(null|\\{[^}]*\\}))?\\}`,
      'g'
    );
    fallback = fallback.replace(
      propsRegex,
      `{\\"${param}\\":\\"${paramPlaceholder(param)}\\"}`
    );
  }

  // Patch route segment: [\"id\",\"X\",\"d\"] → [\"id\",\"__QLARA_FALLBACK_id__\",\"d\"]
  for (const param of paramNames) {
    const segmentRegex = new RegExp(
      `\\[${q}${param}${q},${q}[^"]+${q},${q}d${q}\\]`,
      'g'
    );
    fallback = fallback.replace(
      segmentRegex,
      `[\\"${param}\\",\\"${paramPlaceholder(param)}\\",\\"d\\"]`
    );
  }

  // Patch URL segments in flight data:
  // For /:lang/products/:id with values en,products,99:
  // \"c\":[\"\",\"en\",\"products\",\"99\"] → \"c\":[\"\",\"__QLARA_FALLBACK_lang__\",\"products\",\"__QLARA_FALLBACK_id__\"]
  // Handles interleaved static and dynamic segments.
  const allSegments = routePattern.split('/'); // ['', ':lang', 'products', ':id']
  if (allSegments.length > 1) {
    // Build regex: match the c-array with known static parts and wildcard for dynamic parts
    const regexParts = allSegments.map(seg => {
      if (seg.startsWith(':')) {
        return `${q}[^"]*${q}`; // match any value for dynamic segment
      }
      return `${q}${seg}${q}`; // match literal static segment
    });
    const cArrayRegex = new RegExp(
      `(${q}c${q}:\\[)${regexParts.join(',')}(\\])`,
      'g'
    );

    // Build replacement: static parts stay, dynamic parts get per-param placeholders
    const replacementParts = allSegments.map(seg => {
      if (seg.startsWith(':')) {
        const pName = seg.slice(1);
        return `\\"${paramPlaceholder(pName)}\\"`;
      }
      return `\\"${seg}\\"`;
    });
    const replacement = `$1${replacementParts.join(',')}$2`;

    fallback = fallback.replace(cArrayRegex, replacement);
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
 * Find an existing HTML file to use as a fallback template for a route pattern.
 *
 * For single-param routes like '/product/:id':
 *   Looks in out/product/ for *.html files (simple case).
 *
 * For multi-param routes like '/:lang/products/:id':
 *   Walks the directory tree: out/ → pick any subdir (for :lang) → products/ → pick any .html
 *   Static segments match exact directory names; dynamic segments try any subdirectory.
 *
 * @returns Absolute path to a template HTML file, or null if none found.
 */
export function findTemplateForRoute(buildDir: string, routePattern: string): string | null {
  const segments = routePattern.replace(/^\//, '').split('/');

  function walk(currentDir: string, segmentIndex: number): string | null {
    if (segmentIndex >= segments.length) return null;
    if (!existsSync(currentDir)) return null;

    const segment = segments[segmentIndex];
    const isLast = segmentIndex === segments.length - 1;
    const isDynamic = segment.startsWith(':');

    if (isLast) {
      // Last segment — look for .html files in the current directory
      const files = readdirSync(currentDir).filter(
        f => f.endsWith('.html') && f !== FALLBACK_FILENAME
      );
      return files.length > 0 ? join(currentDir, files[0]) : null;
    }

    if (isDynamic) {
      // Dynamic segment — try any subdirectory (skip _next, hidden dirs)
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          const result = walk(join(currentDir, entry.name), segmentIndex + 1);
          if (result) return result;
        }
      }
      return null;
    }

    // Static segment — descend into exact subdirectory
    return walk(join(currentDir, segment), segmentIndex + 1);
  }

  return walk(buildDir, 0);
}

/**
 * Generate fallback pages for all Qlara dynamic routes.
 * Called during `qlara deploy` before uploading to S3.
 *
 * @param buildDir - The build output directory (e.g., 'out')
 * @param routes - The Qlara route definitions
 * @returns Array of generated fallback file paths (relative to buildDir)
 */
export function generateFallbacks(
  buildDir: string,
  routes: QlaraRoute[]
): string[] {
  const generated: string[] = [];

  for (const route of routes) {
    // Find a template HTML file by walking the directory tree following the route pattern
    const templatePath = findTemplateForRoute(buildDir, route.pattern);

    if (!templatePath) {
      console.warn(
        `[qlara] Warning: No HTML template found for route ${route.pattern}`
      );
      continue;
    }

    const templateHtml = readFileSync(templatePath, 'utf-8');
    const fallbackHtml = generateFallbackFromTemplate(templateHtml, route.pattern);

    // Derive the fallback output path from the static segments of the pattern
    // e.g., '/:lang/products/:id' → 'products/_fallback.html'
    const parts = route.pattern.replace(/^\//, '').split('/');
    const dirParts = parts.filter(p => !p.startsWith(':'));
    const fallbackDir = dirParts.length > 0 ? join(buildDir, ...dirParts) : buildDir;

    // Ensure the output directory exists (may not for multi-param routes where
    // the static-only path doesn't correspond to a real build output directory)
    if (!existsSync(fallbackDir)) {
      mkdirSync(fallbackDir, { recursive: true });
    }

    const fallbackPath = join(fallbackDir, FALLBACK_FILENAME);
    writeFileSync(fallbackPath, fallbackHtml);

    const relativePath = dirParts.length > 0
      ? join(...dirParts, FALLBACK_FILENAME)
      : FALLBACK_FILENAME;
    generated.push(relativePath);
    console.log(`[qlara] Generated fallback: ${relativePath}`);
  }

  return generated;
}
