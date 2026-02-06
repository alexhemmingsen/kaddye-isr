import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { kaddye } from 'kaddye/plugin';

export default defineConfig({
  plugins: [react(), kaddye()],
  build: {
    outDir: 'dist/client',
  },
});
