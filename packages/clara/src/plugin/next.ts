import type { NextConfig } from 'next';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaraPluginConfig, ClaraDeployConfig } from '../types.js';
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
 * Wrap a Next.js config with Clara.
 *
 * During `next build`, this writes two files:
 * - `public/clara-manifest.json` — route patterns for the edge handler (copied to out/ by Next.js)
 * - `.clara/config.json` — deploy config for `clara deploy` to read
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
 *   routes: [{ pattern: '/product/:id' }],
 *   provider: aws({ region: 'eu-west-1' }),
 * })({
 *   output: 'export',
 * });
 * ```
 */
export function withClara(claraConfig: ClaraPluginConfig) {
  validateConfig(claraConfig);

  // Write manifest to public/ — Next.js copies public/ to out/ during static export
  const manifest = buildManifest(claraConfig.routes);
  mkdirSync('public', { recursive: true });
  writeFileSync(
    join('public', 'clara-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  if (acquireLogLock()) {
    console.log('[clara] Manifest written to public/clara-manifest.json');
    console.log('[clara] Deploy config written to .clara/config.json');
    console.log('[clara] Run `clara deploy` to provision and deploy.');
  }

  return (nextConfig: NextConfig): NextConfig => {
    const outputDir = nextConfig.distDir ?? (nextConfig.output === 'export' ? 'out' : '.next');

    // Write deploy config for `clara deploy`
    const deployConfig: ClaraDeployConfig = {
      routes: claraConfig.routes,
      provider: {
        name: claraConfig.provider.name,
        ...claraConfig.provider.config,
      },
      outputDir,
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
