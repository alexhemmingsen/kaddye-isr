import type { KaddyePluginConfig } from './types.js';

export function validateConfig(config: KaddyePluginConfig): void {
  if (!config.routes || !Array.isArray(config.routes)) {
    throw new Error('[kaddye] config.routes must be an array');
  }

  if (config.routes.length === 0) {
    throw new Error('[kaddye] config.routes must contain at least one route');
  }

  if (!config.provider) {
    throw new Error('[kaddye] config.provider is required');
  }

  for (const route of config.routes) {
    if (!route.pattern || typeof route.pattern !== 'string') {
      throw new Error('[kaddye] each route must have a pattern string');
    }

    if (!route.pattern.startsWith('/')) {
      throw new Error(`[kaddye] route pattern must start with '/': ${route.pattern}`);
    }

    if (!route.pattern.includes(':')) {
      throw new Error(
        `[kaddye] route pattern must contain at least one dynamic parameter (e.g. ':id'): ${route.pattern}`
      );
    }
  }
}
