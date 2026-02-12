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
import { mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import archiver from 'archiver';
import { Writable } from 'node:stream';

const BUNDLE_DIR = join('.clara', 'bundles');

/**
 * Resolve the directory of this module at runtime.
 * Works in both ESM (import.meta.url) and CJS (__dirname).
 */
function getModuleDir(): string {
  // In CJS, __dirname is available
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  // In ESM, use import.meta.url
  // @ts-ignore — import.meta is only available in ESM
  const { fileURLToPath } = require('node:url');
  // @ts-ignore
  return dirname(fileURLToPath(import.meta.url));
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
  const moduleDir = getModuleDir();

  await build({
    entryPoints: [resolve(moduleDir, 'edge-handler.ts')],
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
  const moduleDir = getModuleDir();

  await build({
    entryPoints: [resolve(moduleDir, 'renderer.ts')],
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
