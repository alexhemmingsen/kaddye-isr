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
 * @sparticuz/chromium is NOT bundled — it's provided via a Lambda Layer.
 * puppeteer-core IS bundled into the handler.
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
    // @sparticuz/chromium is provided as a Lambda Layer
    external: ['@sparticuz/chromium'],
  });

  return createZip(outfile, 'renderer.js');
}
