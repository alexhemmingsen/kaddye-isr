import { describe, it, expect } from 'vitest';
import { validateConfig } from './config.js';
import type { ClaraPluginConfig, ClaraProvider, ClaraRoute } from './types.js';

function makeProvider(): ClaraProvider {
  return {
    name: 'test',
    config: {},
    async setup() {
      return { provider: 'test' };
    },
    async deploy() {},
    async exists() {
      return null;
    },
    async teardown() {},
  };
}

function makeConfig(
  overrides?: Partial<ClaraPluginConfig>
): ClaraPluginConfig {
  return {
    routeFile: './clara.routes.ts',
    provider: makeProvider(),
    ...overrides,
  };
}

function makeRoutes(patterns: string[] = ['/product/:id']): ClaraRoute[] {
  return patterns.map((pattern) => ({ pattern }));
}

describe('validateConfig', () => {
  it('accepts valid config', () => {
    expect(() => validateConfig(makeConfig(), makeRoutes())).not.toThrow();
  });

  it('accepts multiple routes', () => {
    expect(() =>
      validateConfig(makeConfig(), makeRoutes(['/product/:id', '/blog/:slug']))
    ).not.toThrow();
  });

  it('rejects missing routeFile', () => {
    expect(() =>
      validateConfig({ provider: makeProvider() } as any, makeRoutes())
    ).toThrow('[clara] config.routeFile is required');
  });

  it('rejects empty routes', () => {
    expect(() => validateConfig(makeConfig(), [])).toThrow(
      'no routes found'
    );
  });

  it('rejects missing provider', () => {
    expect(() =>
      validateConfig({ routeFile: './loaders.ts' } as any, makeRoutes())
    ).toThrow('[clara] config.provider is required');
  });

  it('rejects route without leading slash', () => {
    expect(() =>
      validateConfig(makeConfig(), makeRoutes(['product/:id']))
    ).toThrow("route pattern must start with '/'");
  });

  it('rejects route without dynamic param', () => {
    expect(() =>
      validateConfig(makeConfig(), makeRoutes(['/about']))
    ).toThrow('must contain at least one dynamic parameter');
  });

  it('rejects route with empty pattern', () => {
    expect(() =>
      validateConfig(makeConfig(), makeRoutes(['']))
    ).toThrow();
  });
});
