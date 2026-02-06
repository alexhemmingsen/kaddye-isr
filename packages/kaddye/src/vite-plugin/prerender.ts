import { createServer, type ResolvedConfig, type Plugin } from 'vite';
import type { ComponentType, ReactNode } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  type KaddyeConfig,
  type LoadedRoute,
  validateConfig,
  renderRoutes,
  writeRenderedPages,
  writeManifest,
} from '../core';

export interface PrerenderOptions {
  root: string;
  outDir: string;
  base: string;
  configFile: string;
  viteConfig: ResolvedConfig;
}

export async function prerender(options: PrerenderOptions): Promise<void> {
  const { root, outDir, base, configFile } = options;
  const absoluteOutDir = path.resolve(root, outDir);

  // Step 1: Read the build output's index.html as our template
  const clientIndexPath = path.join(absoluteOutDir, 'index.html');
  if (!fs.existsSync(clientIndexPath)) {
    throw new Error(
      `[kaddye] Could not find ${clientIndexPath}. ` +
        `Make sure Vite's build output directory is "${outDir}".`,
    );
  }
  const htmlTemplate = fs.readFileSync(clientIndexPath, 'utf-8');

  // Step 2: Create a temporary Vite server for ssrLoadModule
  const userPlugins = (options.viteConfig.plugins as Plugin[]).filter(
    (p) => p.name !== 'kaddye',
  );

  const server = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    configFile: false,
    resolve: options.viteConfig.resolve,
    plugins: userPlugins,
    optimizeDeps: { noDiscovery: true },
  });

  try {
    // Step 3: Load kaddye config
    const configPath = '/' + configFile;
    const configModule = await server.ssrLoadModule(configPath);
    const config = configModule.default as KaddyeConfig;
    validateConfig(config);

    // Step 4: Load all route components
    const loadedRoutes: LoadedRoute[] = [];
    for (const route of config.routes) {
      const pageModule = await server.ssrLoadModule(route.component);
      const PageComponent = pageModule.default as ComponentType<{
        data: unknown;
      }>;
      if (!PageComponent) {
        console.warn(
          `[kaddye] Warning: Component at "${route.component}" has no default export. Skipping route "${route.path}".`,
        );
        continue;
      }
      const headFn = pageModule.head as
        | ((data: unknown) => ReactNode)
        | undefined;

      loadedRoutes.push({ route, PageComponent, headFn });
    }

    // Step 5: Render all routes using the core engine
    const rootSelector = config.rootSelector ?? '#root';
    const { pages, manifest } = await renderRoutes(loadedRoutes, {
      htmlTemplate,
      rootSelector,
      base,
    });

    // Step 6: Write output
    writeRenderedPages(pages, absoluteOutDir);
    writeManifest(manifest, root, outDir);
  } finally {
    await server.close();
  }
}
