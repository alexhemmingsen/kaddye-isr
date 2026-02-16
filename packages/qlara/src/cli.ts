/**
 * Qlara CLI
 *
 * Usage:
 *   qlara deploy     — Deploy the build output to the configured provider
 *   qlara teardown   — Destroy all provisioned infrastructure
 *
 * Prerequisites:
 *   1. Run `next build` (or your framework's build command) first
 *   2. The build must use the Qlara plugin (e.g. withQlara() in next.config.ts)
 *   3. This creates .qlara/config.json with the deploy config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { QlaraDeployConfig, ProviderResources } from './types.js';
import { QLARA_DIR, RESOURCES_FILE } from './provider/aws/constants.js';
import { aws } from './provider/aws/index.js';

const CONFIG_PATH = join(QLARA_DIR, 'config.json');
const RESOURCES_PATH = join(QLARA_DIR, RESOURCES_FILE);

/**
 * Reconstruct a provider from serialized config.
 */
function createProvider(providerConfig: QlaraDeployConfig['provider']) {
  switch (providerConfig.name) {
    case 'aws':
      return aws({
        stackName: providerConfig.stackName as string | undefined,
        bucketName: providerConfig.bucketName as string | undefined,
        distributionId: providerConfig.distributionId as string | undefined,
        distributionDomain: providerConfig.distributionDomain as string | undefined,
        edgeFunctionArn: providerConfig.edgeFunctionArn as string | undefined,
        rendererFunctionArn: providerConfig.rendererFunctionArn as string | undefined,
      });
    default:
      throw new Error(`[qlara] Unknown provider: ${providerConfig.name}`);
  }
}

/**
 * Load the deploy config from .qlara/config.json.
 */
function loadConfig(): QlaraDeployConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error('[qlara] No config found at .qlara/config.json');
    console.error('[qlara] Run your framework build first (e.g. `next build`)');
    process.exit(1);
  }

  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Load cached resources from .qlara/resources.json.
 */
function loadResources(): ProviderResources | null {
  if (!existsSync(RESOURCES_PATH)) return null;
  return JSON.parse(readFileSync(RESOURCES_PATH, 'utf-8'));
}

/**
 * Save resources to .qlara/resources.json.
 */
function saveResources(resources: ProviderResources): void {
  mkdirSync(QLARA_DIR, { recursive: true });
  writeFileSync(RESOURCES_PATH, JSON.stringify(resources, null, 2));
}

async function deploy() {
  const config = loadConfig();
  const provider = createProvider(config.provider);

  // Always run setup — it handles both creating new stacks and updating existing ones
  console.log(`[qlara] Setting up ${provider.name} infrastructure...`);
  const resources = await provider.setup(config);
  saveResources(resources);

  // Deploy
  console.log(`[qlara] Deploying to ${provider.name}...`);
  await provider.deploy(config, resources);
}

async function teardown() {
  const config = loadConfig();
  const provider = createProvider(config.provider);

  const resources = loadResources();
  if (!resources) {
    console.error('[qlara] No resources found. Nothing to tear down.');
    process.exit(1);
  }

  console.log(`[qlara] Tearing down ${provider.name} infrastructure...`);
  await provider.teardown(resources);

  // Clean up local state
  if (existsSync(RESOURCES_PATH)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(RESOURCES_PATH);
  }

  console.log('[qlara] Teardown complete');
}

// ── CLI entry point ──────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case 'deploy':
    deploy().catch((err) => {
      console.error(`[qlara] Deploy failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'teardown':
    teardown().catch((err) => {
      console.error(`[qlara] Teardown failed: ${err.message}`);
      process.exit(1);
    });
    break;

  default:
    console.log('Qlara — Runtime ISR for static React apps\n');
    console.log('Usage:');
    console.log('  qlara deploy     Deploy the build to the configured provider');
    console.log('  qlara teardown   Destroy all provisioned infrastructure');
    console.log('');
    console.log('Before deploying, run your framework build (e.g. `next build`).');
    if (!command) process.exit(0);
    else {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}
