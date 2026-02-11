import type { NextConfig } from 'next';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { KaddyePluginConfig, ProviderResources } from '../types.js';
import { validateConfig } from '../config.js';
import { buildManifest } from '../routes.js';

const RESOURCES_DIR = '.kaddye';
const RESOURCES_FILE = 'resources.json';

/**
 * Wrap a Next.js config with Kaddye.
 *
 * Usage:
 * ```typescript
 * import { withKaddye } from 'kaddye/next';
 * import { aws } from 'kaddye/aws';
 *
 * export default withKaddye({
 *   routes: [{ pattern: '/product/:id' }],
 *   provider: aws({ region: 'eu-west-1' }),
 * })({
 *   output: 'export',
 * });
 * ```
 */
export function withKaddye(kaddyeConfig: KaddyePluginConfig) {
  // Validate and write manifest immediately when config is loaded.
  // For static export, writing to public/ ensures Next.js copies it to out/.
  validateConfig(kaddyeConfig);
  const manifest = buildManifest(kaddyeConfig.routes);

  mkdirSync('public', { recursive: true });
  writeFileSync(
    join('public', 'kaddye-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  return (nextConfig: NextConfig): NextConfig => {
    const outputDir = nextConfig.distDir ?? (nextConfig.output === 'export' ? 'out' : '.next');

    return {
      ...nextConfig,
      webpack(config, options) {
        // Preserve user's existing webpack config
        if (typeof nextConfig.webpack === 'function') {
          config = nextConfig.webpack(config, options);
        }

        // After client production build: provision infrastructure + deploy
        if (!options.isServer && !options.dev) {
          const { Compiler } = options.webpack;
          config.plugins.push({
            apply(compiler: InstanceType<typeof Compiler>) {
              compiler.hooks.done.tapPromise('KaddyePlugin', async () => {
                await handleDeploy(kaddyeConfig, outputDir);
              });
            },
          });
        }

        return config;
      },
    };
  };
}

async function handleDeploy(config: KaddyePluginConfig, outputDir: string) {
  console.log('\n[kaddye] Manifest written to public/kaddye-manifest.json');

  // Check if infrastructure exists
  const resourcesPath = resolve(RESOURCES_DIR, RESOURCES_FILE);
  let resources: ProviderResources | null = null;

  if (existsSync(resourcesPath)) {
    resources = JSON.parse(readFileSync(resourcesPath, 'utf-8'));
    console.log(`[kaddye] Found existing ${config.provider.name} infrastructure`);
  } else {
    resources = await config.provider.exists(config);
  }

  if (!resources) {
    try {
      console.log(`[kaddye] No infrastructure found. Provisioning with ${config.provider.name}...`);
      resources = await config.provider.setup(config);

      mkdirSync(RESOURCES_DIR, { recursive: true });
      writeFileSync(resourcesPath, JSON.stringify(resources, null, 2));
      console.log(`[kaddye] Infrastructure provisioned. Resources saved to ${resourcesPath}`);
    } catch (err) {
      console.warn(`[kaddye] Could not provision infrastructure: ${(err as Error).message}`);
      console.warn('[kaddye] Skipping deploy. Manifest was written successfully.');
      return;
    }
  }

  try {
    console.log(`[kaddye] Deploying to ${config.provider.name}...`);
    await config.provider.deploy(config, resources, outputDir);
    console.log('[kaddye] Deploy complete!');
  } catch (err) {
    console.warn(`[kaddye] Deploy failed: ${(err as Error).message}`);
    console.warn('[kaddye] Build succeeded. Deploy manually when ready.');
  }
}
