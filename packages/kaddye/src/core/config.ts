import type { KaddyeConfig } from './types';
import { isDynamicRoute } from './routes';

export function defineConfig(config: KaddyeConfig): KaddyeConfig {
  return config;
}

export function validateConfig(
  config: unknown,
): asserts config is KaddyeConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('[kaddye] Config must be an object');
  }

  const cfg = config as Record<string, unknown>;

  if (cfg.rootSelector !== undefined && typeof cfg.rootSelector !== 'string') {
    throw new Error(
      '[kaddye] Config "rootSelector" must be a string if provided',
    );
  }

  if (!Array.isArray(cfg.routes)) {
    throw new Error('[kaddye] Config "routes" must be an array');
  }

  if (cfg.routes.length === 0) {
    throw new Error('[kaddye] Config "routes" must contain at least one route');
  }

  for (let i = 0; i < cfg.routes.length; i++) {
    const route = cfg.routes[i] as Record<string, unknown>;
    const prefix = `[kaddye] routes[${i}]`;

    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error(`${prefix}: "path" must be a string starting with "/"`);
    }

    if (!isDynamicRoute(route.path as string)) {
      throw new Error(
        `${prefix}: "${route.path}" is a static route. ` +
          `Kaddye only handles dynamic routes (paths with :param segments). ` +
          `Static pages are served by your framework's normal build output.`,
      );
    }

    if (typeof route.component !== 'string' || !route.component) {
      throw new Error(
        `${prefix}: "component" must be a non-empty string path`,
      );
    }

    if (route.data !== undefined && typeof route.data !== 'function') {
      throw new Error(`${prefix}: "data" must be a function if provided`);
    }

    if (
      route.staticParams !== undefined &&
      typeof route.staticParams !== 'function'
    ) {
      throw new Error(
        `${prefix}: "staticParams" must be a function if provided`,
      );
    }

    if (!route.staticParams) {
      console.warn(
        `${prefix}: Dynamic route "${route.path}" has no "staticParams". ` +
          `It will not be pre-rendered at build time (will rely on ISR).`,
      );
    }
  }
}
