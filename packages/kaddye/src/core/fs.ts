import fs from 'node:fs';
import path from 'node:path';
import type { RenderedPage, KaddyeManifest } from './types';

export function writeRenderedPages(
  pages: RenderedPage[],
  outDir: string,
): void {
  for (const page of pages) {
    const filePath = pathToFilePath(page.path, outDir);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, page.html, 'utf-8');
    console.log(`[kaddye]   wrote: ${path.relative(outDir, filePath)}`);
  }
}

export function writeManifest(
  manifest: KaddyeManifest,
  rootDir: string,
  outDirRelative: string,
): void {
  const manifestPath = path.join(
    path.resolve(rootDir, path.dirname(outDirRelative)),
    'kaddye-manifest.json',
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`[kaddye]   wrote: ${path.relative(rootDir, manifestPath)}`);
}

function pathToFilePath(urlPath: string, outDir: string): string {
  const segments = urlPath.replace(/^\//, '');
  return path.join(outDir, segments, 'index.html');
}
