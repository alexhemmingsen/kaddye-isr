import { describe, it, expect } from 'vitest';
import { validateConfig } from './config.js';
import type { ClaraPluginConfig, ClaraProvider } from './types.js';

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
    routes: [{ pattern: '/product/:id' }],
    provider: makeProvider(),
    ...overrides,
  };
}

describe('validateConfig', () => {
  it('accepts valid config', () => {
    expect(() => validateConfig(makeConfig())).not.toThrow();
  });

  it('accepts multiple routes', () => {
    expect(() =>
      validateConfig(
        makeConfig({
          routes: [
            { pattern: '/product/:id' },
            { pattern: '/blog/:slug' },
          ],
        })
      )
    ).not.toThrow();
  });

  it('rejects missing routes', () => {
    expect(() =>
      validateConfig({ provider: makeProvider() } as any)
    ).toThrow('[clara] config.routes must be an array');
  });

  it('rejects empty routes', () => {
    expect(() => validateConfig(makeConfig({ routes: [] }))).toThrow(
      '[clara] config.routes must contain at least one route'
    );
  });

  it('rejects missing provider', () => {
    expect(() =>
      validateConfig({ routes: [{ pattern: '/x/:id' }] } as any)
    ).toThrow('[clara] config.provider is required');
  });

  it('rejects route without leading slash', () => {
    expect(() =>
      validateConfig(makeConfig({ routes: [{ pattern: 'product/:id' }] }))
    ).toThrow("route pattern must start with '/'");
  });

  it('rejects route without dynamic param', () => {
    expect(() =>
      validateConfig(makeConfig({ routes: [{ pattern: '/about' }] }))
    ).toThrow('must contain at least one dynamic parameter');
  });

  it('rejects route with empty pattern', () => {
    expect(() =>
      validateConfig(makeConfig({ routes: [{ pattern: '' }] }))
    ).toThrow();
  });
});
