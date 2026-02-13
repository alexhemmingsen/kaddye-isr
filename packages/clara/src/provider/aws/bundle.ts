/**
 * Lambda bundling utilities for Clara.
 *
 * Bundles the edge handler and renderer into self-contained ZIP files
 * ready for deployment to AWS Lambda.
 *
 * At deploy time, esbuild resolves the entry points from the installed
 * clara package's source (or dist). The entry point paths are resolved
 * relative to this file's location.
 */

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { Writable } from 'node:stream';

const BUNDLE_DIR = join('.clara', 'bundles');

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
 * Resolve a Lambda entry point file.
 *
 * When running from dist/, source .ts files are at ../src/provider/aws/.
 * When running from src/provider/aws/ directly (vitest), they're in the same dir.
 */
function resolveEntry(name: string): string {
  const moduleDir = getModuleDir();

  // Same directory (running from source)
  const sameDirTs = resolve(moduleDir, `${name}.ts`);
  if (existsSync(sameDirTs)) return sameDirTs;

  // Running from dist/ — resolve to src/provider/aws/
  const srcTs = resolve(moduleDir, '..', 'src', 'provider', 'aws', `${name}.ts`);
  if (existsSync(srcTs)) return srcTs;

  // Fallback: .js in same directory
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

/**
 * Create a ZIP buffer from a file + additional directories.
 */
async function createZipWithDirs(
  filePath: string,
  entryName: string,
  dirs: Array<{ source: string; target: string }>
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const converter = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    // Use zlib level 1 (fast) — the chromium binaries are already brotli-compressed
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', reject);
    converter.on('finish', () => resolvePromise(Buffer.concat(chunks)));

    archive.pipe(converter);
    archive.file(filePath, { name: entryName });
    for (const dir of dirs) {
      archive.directory(dir.source, dir.target);
    }
    archive.finalize();
  });
}

/**
 * Find the @sparticuz/chromium bin/ directory using Node's module resolution.
 *
 * Uses require.resolve() to locate the package entry point, then derives
 * the bin/ path relative to it. The bin/ folder contains brotli-compressed
 * chromium binaries that are too large for esbuild to bundle.
 * The JS code from @sparticuz/chromium IS bundled by esbuild.
 */
function findChromiumBinDir(): string {
  try {
    // Use createRequire for ESM compatibility
    const req = createRequire(import.meta.url);
    // resolve() returns e.g. .../node_modules/@sparticuz/chromium/build/index.js
    const entryPath = req.resolve('@sparticuz/chromium');
    // bin/ is a sibling of build/ in the package root
    const packageDir = join(entryPath, '..', '..');
    const binDir = join(packageDir, 'bin');

    if (!existsSync(binDir)) {
      throw new Error(`bin/ directory not found at ${binDir}`);
    }

    return binDir;
  } catch (err) {
    throw new Error(
      `[clara] @sparticuz/chromium bin/ directory not found. Install @sparticuz/chromium as a dependency. (${(err as Error).message})`
    );
  }
}

export interface EdgeHandlerConfig {
  bucketName: string;
  rendererArn: string;
  region: string;
  distributionDomain: string;
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
      __CLARA_BUCKET_NAME__: JSON.stringify(config.bucketName),
      __CLARA_RENDERER_ARN__: JSON.stringify(config.rendererArn),
      __CLARA_REGION__: JSON.stringify(config.region),
      __CLARA_DISTRIBUTION_DOMAIN__: JSON.stringify(config.distributionDomain),
    },
    // Bundle everything — Lambda@Edge must be self-contained
    external: [],
  });

  return createZip(outfile, 'edge-handler.js');
}

/**
 * Bundle the renderer Lambda handler into a ZIP.
 *
 * @sparticuz/chromium JS is fully bundled by esbuild (along with puppeteer-core
 * and all other dependencies). Only the chromium bin/ directory (brotli-compressed
 * binaries) is included separately in the ZIP at the root level, so it unpacks
 * to /var/task/bin/ in Lambda. The renderer calls chromium.executablePath('/var/task/bin')
 * to locate the binaries.
 */
export async function bundleRenderer(): Promise<Buffer> {
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const outfile = join(BUNDLE_DIR, 'renderer.js');

  await build({
    entryPoints: [resolveEntry('renderer')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    minify: true,
    // Bundle everything including @sparticuz/chromium JS.
    // The bin/ directory (chromium binaries) is included separately in the ZIP.
    external: [],
  });

  // Include only the bin/ directory from @sparticuz/chromium in the ZIP.
  // These are the brotli-compressed chromium binaries that can't be bundled by esbuild.
  // Placed at root level → unpacks to /var/task/bin/ in Lambda.
  const chromiumBinDir = findChromiumBinDir();

  return createZipWithDirs(outfile, 'renderer.js', [
    {
      source: chromiumBinDir,
      target: 'bin',
    },
  ]);
}
