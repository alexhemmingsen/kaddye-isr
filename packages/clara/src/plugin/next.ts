import type { NextConfig } from 'next';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ClaraPluginConfig, ClaraDeployConfig, ClaraRoute } from '../types.js';
import { validateConfig } from '../config.js';
import { buildManifest } from '../routes.js';

const CLARA_DIR = '.clara';
const CONFIG_FILE = 'config.json';
const LOCK_FILE = '.clara/.build-lock';

/**
 * Check if another process already logged during this build.
 * Uses a lock file with a timestamp (10-second window).
 * This prevents log spam when Next.js evaluates the config in multiple workers.
 */
function acquireLogLock(): boolean {
  mkdirSync(CLARA_DIR, { recursive: true });

  // 10-second window — all workers during a single `next build` invocation
  // fall within the same window. A new `next build` (>10s later) logs again.
  const window = Math.floor(Date.now() / 10000).toString();

  try {
    if (existsSync(LOCK_FILE)) {
      const existing = readFileSync(LOCK_FILE, 'utf-8').trim();
      if (existing === window) return false; // Another process already logged
    }
  } catch {
    // Ignore read errors
  }

  try {
    writeFileSync(LOCK_FILE, window);
  } catch {
    // Ignore write errors
  }

  return true;
}

/**
 * Extract route patterns from the route file by reading it as text.
 *
 * Matches `route:` property values in the exported array, e.g.:
 *   { route: '/product/:id', metaDataGenerator: async (params) => { ... } }
 *
 * This avoids importing the file (which may have side effects or dependencies).
 */
function extractRoutesFromRouteFile(routeFilePath: string): ClaraRoute[] {
  const absPath = resolve(routeFilePath);
  if (!existsSync(absPath)) {
    throw new Error(`[clara] Route file not found: ${absPath}`);
  }

  const source = readFileSync(absPath, 'utf-8');

  // Match route: '/pattern' or route: "/pattern" values
  const patterns: string[] = [];
  const regex = /route\s*:\s*['"](\/.+?)['"]/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const pattern = match[1];
    // Only include patterns with dynamic params (contain ':')
    if (pattern.includes(':')) {
      patterns.push(pattern);
    }
  }

  if (patterns.length === 0) {
    throw new Error(
      `[clara] No route patterns found in ${routeFilePath}. ` +
      `Each entry should have a route property like '/product/:id'.`
    );
  }

  return patterns.map((pattern) => ({ pattern }));
}

/**
 * Wrap a Next.js config with Clara.
 *
 * During `next build`, this writes two files:
 * - `public/clara-manifest.json` — route patterns for the edge handler (copied to out/ by Next.js)
 * - `.clara/config.json` — deploy config for `clara deploy` to read
 *
 * Route patterns are extracted automatically from the route file.
 *
 * The build itself is unaffected — no deploy, no AWS calls, no side effects.
 * Run `clara deploy` separately to provision infrastructure and deploy.
 *
 * Usage:
 * ```typescript
 * import { withClara } from 'clara/next';
 * import { aws } from 'clara/aws';
 *
 * export default withClara({
 *   routeFile: './clara.routes.ts',
 *   provider: aws(),
 * })({
 *   output: 'export',
 * });
 * ```
 */
export function withClara(claraConfig: ClaraPluginConfig) {
  // Extract routes from the route file
  const routes = extractRoutesFromRouteFile(claraConfig.routeFile);

  validateConfig(claraConfig, routes);

  // Write manifest to public/ — Next.js copies public/ to out/ during static export
  const manifest = buildManifest(routes);
  mkdirSync('public', { recursive: true });
  writeFileSync(
    join('public', 'clara-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  if (acquireLogLock()) {
    console.log(`[clara] Found ${routes.length} route(s) in ${claraConfig.routeFile}`);
    console.log('[clara] Manifest written to public/clara-manifest.json');
    console.log('[clara] Run `clara deploy` after building to provision and deploy.');
  }

  return (nextConfig: NextConfig): NextConfig => {
    const outputDir = nextConfig.distDir ?? (nextConfig.output === 'export' ? 'out' : '.next');

    // Write deploy config for `clara deploy`
    const deployConfig: ClaraDeployConfig = {
      routes,
      provider: {
        name: claraConfig.provider.name,
        ...claraConfig.provider.config,
      },
      outputDir,
      routeFile: resolve(claraConfig.routeFile),
    };

    mkdirSync(CLARA_DIR, { recursive: true });
    writeFileSync(
      join(CLARA_DIR, CONFIG_FILE),
      JSON.stringify(deployConfig, null, 2)
    );

    // Pass through the Next.js config unmodified
    return nextConfig;
  };
}
