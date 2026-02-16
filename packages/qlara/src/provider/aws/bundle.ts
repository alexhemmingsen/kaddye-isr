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
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { Writable } from 'node:stream';

const BUNDLE_DIR = join('.qlara', 'bundles');

/**
 * Resolve the directory of this module at runtime.
 * Works in both ESM (import.meta.url) and CJS (__dirname).
 */
function getModuleDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Find the qlara package root by walking up from the module directory
 * until we find a package.json with name "qlara".
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const { readFileSync } = require('node:fs');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'qlara') return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * Resolve a Lambda entry point file.
 *
 * The edge-handler.ts and renderer.ts are shipped as source in the npm package
 * under src/provider/aws/. esbuild bundles them at deploy time into self-contained
 * Lambda ZIP files.
 *
 * Search order:
 * 1. Same directory as this module (running from source — vitest, monorepo)
 * 2. Package root's src/provider/aws/ (installed from npm)
 * 3. Fallback: .js in same directory
 */
function resolveEntry(name: string): string {
  const moduleDir = getModuleDir();

  // 1. Same directory (running from source — vitest, monorepo dev)
  const sameDirTs = resolve(moduleDir, `${name}.ts`);
  if (existsSync(sameDirTs)) return sameDirTs;

  // 2. Package root's src/provider/aws/ (installed from npm)
  const pkgRoot = findPackageRoot(moduleDir);
  const pkgSrcTs = resolve(pkgRoot, 'src', 'provider', 'aws', `${name}.ts`);
  if (existsSync(pkgSrcTs)) return pkgSrcTs;

  // 3. Fallback: .js in same directory
  return resolve(moduleDir, `${name}.js`);
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
export async function bundleRenderer(routeFile?: string): Promise<Buffer> {
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
    external: [],
  });

  return createZip(outfile, 'renderer.js');
}
