/**
 * Lambda bundling utilities for Qlara.
 *
 * Bundles the edge handler and renderer into self-contained ZIP files
 * ready for deployment to AWS Lambda.
 *
 * At deploy time, esbuild resolves the entry points from the installed
 * qlara package's source (or dist). The entry point paths are resolved
 * relative to this file's location.
 */

import { build } from 'esbuild';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import archiver from 'archiver';
import { Writable } from 'node:stream';

const BUNDLE_DIR = join('.qlara', 'bundles');

/**
 * Resolve a Lambda entry point file.
 *
 * The edge-handler.ts and renderer.ts are shipped as source in the npm package
 * under src/provider/aws/. esbuild bundles them at deploy time into self-contained
 * Lambda ZIP files.
 *
 * We find the qlara package root by resolving 'qlara/package.json' through Node's
 * module resolution — this works in all environments (pnpm, npm, monorepo).
 */
function resolveEntry(name: string): string {
  // 1. Running from source (vitest, monorepo dev) — same directory
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const sameDirTs = resolve(thisDir, `${name}.ts`);
  if (existsSync(sameDirTs)) return sameDirTs;

  // 2. Installed from npm — use Node's module resolution to find the package
  try {
    const esmRequire = createRequire(import.meta.url);
    const pkgJsonPath = esmRequire.resolve('qlara/package.json');
    const pkgRoot = dirname(pkgJsonPath);
    const srcTs = join(pkgRoot, 'src', 'provider', 'aws', `${name}.ts`);
    if (existsSync(srcTs)) return srcTs;
  } catch {}

  // 3. Relative to dist/ (fallback for monorepo where 'qlara' isn't a resolvable module name)
  const fromDist = resolve(thisDir, '..', 'src', 'provider', 'aws', `${name}.ts`);
  if (existsSync(fromDist)) return fromDist;

  throw new Error(
    `[qlara] Could not find ${name}.ts Lambda source file. ` +
    `Searched:\n  ${sameDirTs}\n  ${fromDist}`
  );
}

/**
 * Create a ZIP buffer from a single file.
 */
async function createZip(filePath: string, entryName: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const converter = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    converter.on('finish', () => resolvePromise(Buffer.concat(chunks)));

    archive.pipe(converter);
    archive.file(filePath, { name: entryName });
    archive.finalize();
  });
}

export interface EdgeHandlerConfig {
  bucketName: string;
  rendererArn: string;
  region: string;
  cacheTtl: number;
}

/**
 * Bundle the Lambda@Edge handler into a ZIP.
 *
 * Config values are baked into the bundle via esbuild `define` because
 * Lambda@Edge does not support environment variables.
 *
 * All dependencies (AWS SDK) are bundled — no externals.
 */
export async function bundleEdgeHandler(
  config: EdgeHandlerConfig
): Promise<Buffer> {
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const outfile = join(BUNDLE_DIR, 'edge-handler.js');

  await build({
    entryPoints: [resolveEntry('edge-handler')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    minify: true,
    define: {
      __QLARA_BUCKET_NAME__: JSON.stringify(config.bucketName),
      __QLARA_RENDERER_ARN__: JSON.stringify(config.rendererArn),
      __QLARA_REGION__: JSON.stringify(config.region),
      __QLARA_CACHE_TTL__: String(config.cacheTtl),
    },
    // Bundle everything — Lambda@Edge must be self-contained
    external: [],
  });

  return createZip(outfile, 'edge-handler.js');
}

/**
 * Bundle the renderer Lambda handler into a ZIP.
 *
 * The renderer fetches metadata from the developer's data source using
 * metadata generators, then patches the fallback HTML with real SEO metadata.
 * No browser or Chromium needed.
 *
 * The developer's route file is bundled into the renderer via esbuild's
 * `alias` option: the renderer imports from '__qlara_routes__', which
 * esbuild resolves to the actual route file path.
 *
 * @param routeFile - Absolute path to the developer's route file
 */
export async function bundleRenderer(routeFile?: string, cacheTtl: number = 3600, framework?: string): Promise<Buffer> {
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const outfile = join(BUNDLE_DIR, 'renderer.js');

  // Map the virtual import '__qlara_routes__' to the developer's route file.
  // If no route file is provided, map to an empty module.
  const alias: Record<string, string> = {};
  if (routeFile) {
    alias['__qlara_routes__'] = resolve(routeFile);
  } else {
    // Create a no-op routes module inline via esbuild stdin won't work here,
    // so we create a temporary file
    const noopPath = join(BUNDLE_DIR, '__qlara_noop_routes.js');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(noopPath, 'module.exports = { default: [] };');
    alias['__qlara_routes__'] = resolve(noopPath);
  }

  await build({
    entryPoints: [resolveEntry('renderer')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    minify: true,
    alias,
    define: {
      __QLARA_CACHE_TTL__: String(cacheTtl),
      __QLARA_FRAMEWORK__: JSON.stringify(framework || ''),
    },
    external: [],
  });

  return createZip(outfile, 'renderer.js');
}
