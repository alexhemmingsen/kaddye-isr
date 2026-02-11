import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugin/next.ts',
    'src/aws.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['next', 'react', 'react-dom', 'webpack'],
});
