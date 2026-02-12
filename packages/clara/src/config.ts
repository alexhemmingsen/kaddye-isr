import type { ClaraPluginConfig } from './types.js';

export function validateConfig(config: ClaraPluginConfig): void {
  if (!config.routes || !Array.isArray(config.routes)) {
    throw new Error('[clara] config.routes must be an array');
  }

  if (config.routes.length === 0) {
    throw new Error('[clara] config.routes must contain at least one route');
  }

  if (!config.provider) {
    throw new Error('[clara] config.provider is required');
  }

  for (const route of config.routes) {
    if (!route.pattern || typeof route.pattern !== 'string') {
      throw new Error('[clara] each route must have a pattern string');
    }

    if (!route.pattern.startsWith('/')) {
      throw new Error(`[clara] route pattern must start with '/': ${route.pattern}`);
    }

    if (!route.pattern.includes(':')) {
      throw new Error(
        `[clara] route pattern must contain at least one dynamic parameter (e.g. ':id'): ${route.pattern}`
      );
    }
  }
}
