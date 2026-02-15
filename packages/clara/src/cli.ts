/**
 * Clara CLI
 *
 * Usage:
 *   clara deploy     — Deploy the build output to the configured provider
 *   clara teardown   — Destroy all provisioned infrastructure
 *
 * Prerequisites:
 *   1. Run `next build` (or your framework's build command) first
 *   2. The build must use the Clara plugin (e.g. withClara() in next.config.ts)
 *   3. This creates .clara/config.json with the deploy config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaraDeployConfig, ProviderResources } from './types.js';
import { CLARA_DIR, RESOURCES_FILE } from './provider/aws/constants.js';
import { aws } from './provider/aws/index.js';

const CONFIG_PATH = join(CLARA_DIR, 'config.json');
const RESOURCES_PATH = join(CLARA_DIR, RESOURCES_FILE);

/**
 * Reconstruct a provider from serialized config.
 */
function createProvider(providerConfig: ClaraDeployConfig['provider']) {
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
      throw new Error(`[clara] Unknown provider: ${providerConfig.name}`);
  }
}

/**
 * Load the deploy config from .clara/config.json.
 */
function loadConfig(): ClaraDeployConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error('[clara] No config found at .clara/config.json');
    console.error('[clara] Run your framework build first (e.g. `next build`)');
    process.exit(1);
  }

  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * Load cached resources from .clara/resources.json.
 */
function loadResources(): ProviderResources | null {
  if (!existsSync(RESOURCES_PATH)) return null;
  return JSON.parse(readFileSync(RESOURCES_PATH, 'utf-8'));
}

/**
 * Save resources to .clara/resources.json.
 */
function saveResources(resources: ProviderResources): void {
  mkdirSync(CLARA_DIR, { recursive: true });
  writeFileSync(RESOURCES_PATH, JSON.stringify(resources, null, 2));
}

async function deploy() {
  const config = loadConfig();
  const provider = createProvider(config.provider);

  // Always run setup — it handles both creating new stacks and updating existing ones
  console.log(`[clara] Setting up ${provider.name} infrastructure...`);
  const resources = await provider.setup(config);
  saveResources(resources);

  // Deploy
  console.log(`[clara] Deploying to ${provider.name}...`);
  await provider.deploy(config, resources);
}

async function teardown() {
  const config = loadConfig();
  const provider = createProvider(config.provider);

  const resources = loadResources();
  if (!resources) {
    console.error('[clara] No resources found. Nothing to tear down.');
    process.exit(1);
  }

  console.log(`[clara] Tearing down ${provider.name} infrastructure...`);
  await provider.teardown(resources);

  // Clean up local state
  if (existsSync(RESOURCES_PATH)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(RESOURCES_PATH);
  }

  console.log('[clara] Teardown complete');
}

// ── CLI entry point ──────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case 'deploy':
    deploy().catch((err) => {
      console.error(`[clara] Deploy failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'teardown':
    teardown().catch((err) => {
      console.error(`[clara] Teardown failed: ${err.message}`);
      process.exit(1);
    });
    break;

  default:
    console.log('Clara — Runtime ISR for static React apps\n');
    console.log('Usage:');
    console.log('  clara deploy     Deploy the build to the configured provider');
    console.log('  clara teardown   Destroy all provisioned infrastructure');
    console.log('');
    console.log('Before deploying, run your framework build (e.g. `next build`).');
    if (!command) process.exit(0);
    else {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}
