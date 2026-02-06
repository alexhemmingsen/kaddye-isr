import type { Plugin, ResolvedConfig } from 'vite';
import { prerender } from './prerender';

export interface KaddyePluginOptions {
  /** Path to the kaddye config file, relative to project root. Defaults to 'kaddye.config.ts'. */
  configFile?: string;
}

export function kaddye(options: KaddyePluginOptions = {}): Plugin {
  const configFile = options.configFile ?? 'kaddye.config.ts';
  let resolvedConfig: ResolvedConfig;

  return {
    name: 'kaddye',
    apply: 'build',

    configResolved(config) {
      resolvedConfig = config;
    },

    async closeBundle() {
      const root = resolvedConfig.root;
      const outDir = resolvedConfig.build.outDir;
      const base = resolvedConfig.base;

      console.log('\n[kaddye] Pre-rendering routes...\n');

      try {
        await prerender({
          root,
          outDir,
          base,
          configFile,
          viteConfig: resolvedConfig,
        });
        console.log('[kaddye] Pre-rendering complete.\n');
      } catch (err) {
        console.error('[kaddye] Pre-rendering failed:', err);
        throw err;
      }
    },
  };
}

export default kaddye;
