import type { QlaraPluginConfig, QlaraRoute } from './types.js';

export function validateConfig(config: QlaraPluginConfig, routes: QlaraRoute[]): void {
  if (!config.routeFile || typeof config.routeFile !== 'string') {
    throw new Error('[qlara] config.routeFile is required');
  }

  if (!config.provider) {
    throw new Error('[qlara] config.provider is required');
  }

  if (routes.length === 0) {
    throw new Error('[qlara] no routes found — routeFile must export at least one route pattern');
  }

  for (const route of routes) {
    if (!route.pattern || typeof route.pattern !== 'string') {
      throw new Error('[qlara] each route must have a pattern string');
    }

    if (!route.pattern.startsWith('/')) {
      throw new Error(`[qlara] route pattern must start with '/': ${route.pattern}`);
    }

    if (!route.pattern.includes(':')) {
      throw new Error(
        `[qlara] route pattern must contain at least one dynamic parameter (e.g. ':id'): ${route.pattern}`
      );
    }
  }
}
