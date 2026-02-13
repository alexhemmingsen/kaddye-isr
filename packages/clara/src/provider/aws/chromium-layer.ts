/**
 * Chromium Lambda Layer builder for Clara.
 *
 * Packages the locally installed @sparticuz/chromium npm package into a
 * Lambda Layer ZIP. The layer is published to AWS Lambda during `clara deploy`
 * and attached to the renderer function.
 *
 * Layer structure:
 *   nodejs/node_modules/@sparticuz/chromium/   ← the entire package
 *
 * This avoids depending on third-party public layer ARNs and ensures
 * the chromium version matches what the renderer was bundled against.
 */

import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import archiver from 'archiver';
import { Writable } from 'node:stream';

/**
 * Find the @sparticuz/chromium package directory.
 *
 * Uses require.resolve to locate the package entry point, then walks up
 * to the package root. Falls back to manual node_modules search.
 */
export function findChromiumPackage(): string {
  // Try require.resolve — works in both CJS and ESM (via createRequire)
  try {
    const req =
      typeof require !== 'undefined'
        ? require
        : createRequire(import.meta.url);
    const mainFile = req.resolve('@sparticuz/chromium');
    // mainFile is something like .../node_modules/@sparticuz/chromium/build/index.js
    // Walk up to the package root (directory with package.json)
    let dir = dirname(mainFile);
    while (dir !== '/' && !existsSync(join(dir, 'package.json'))) {
      dir = dirname(dir);
    }
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
  } catch {
    // require.resolve failed — try manual search
  }

  // Manual search: walk up from this file looking for node_modules
  let searchDir: string;
  try {
    searchDir =
      typeof __dirname !== 'undefined'
        ? __dirname
        : dirname(new URL(import.meta.url).pathname);
  } catch {
    searchDir = process.cwd();
  }

  for (let i = 0; i < 10; i++) {
    const candidate = join(searchDir, 'node_modules', '@sparticuz', 'chromium');
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    searchDir = dirname(searchDir);
  }

  throw new Error(
    '[clara/aws] @sparticuz/chromium not found. ' +
    'Install it: pnpm add @sparticuz/chromium'
  );
}

/**
 * Build a Lambda Layer ZIP containing the @sparticuz/chromium package.
 *
 * Returns a Buffer containing the ZIP file ready for Lambda PublishLayerVersion.
 */
export async function buildChromiumLayerZip(): Promise<Buffer> {
  const chromiumDir = findChromiumPackage();

  console.log(`[clara/aws] Packaging Chromium layer from ${chromiumDir}`);

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

    // Add the entire @sparticuz/chromium package under the Lambda Layer
    // Node.js layer path: nodejs/node_modules/@sparticuz/chromium/
    archive.directory(
      chromiumDir,
      'nodejs/node_modules/@sparticuz/chromium'
    );

    archive.finalize();
  });
}
