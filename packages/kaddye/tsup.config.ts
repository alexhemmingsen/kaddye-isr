import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    clean: true,
    external: ['react', 'react-dom', 'vite'],
  },
  {
    entry: {
      'vite-plugin/index': 'src/vite-plugin/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    clean: false,
    external: ['react', 'react-dom', 'vite'],
  },
]);
