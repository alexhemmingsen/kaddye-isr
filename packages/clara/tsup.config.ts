import { defineConfig } from 'tsup';

export default defineConfig([
  // Main library builds (ESM + CJS with declarations)
  {
    entry: [
      'src/index.ts',
      'src/plugin/next.ts',
      'src/aws.ts',
    ],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    external: [
      'next',
      'react',
      'react-dom',
      'webpack',
      '@aws-sdk/client-s3',
      '@aws-sdk/client-cloudformation',
      '@aws-sdk/client-lambda',
      '@aws-sdk/client-cloudfront',
      'esbuild',
      'archiver',
      'puppeteer-core',
      '@sparticuz/chromium',
    ],
  },
  // CLI binary (ESM only, no declarations)
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    external: [
      '@aws-sdk/client-s3',
      '@aws-sdk/client-cloudformation',
      '@aws-sdk/client-lambda',
      '@aws-sdk/client-cloudfront',
      'esbuild',
      'archiver',
      'puppeteer-core',
      '@sparticuz/chromium',
    ],
  },
]);
