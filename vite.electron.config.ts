import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { buildDefines } from './vite.defines.ts';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: buildDefines(),
  build: {
    outDir: 'dist-electron/renderer',
    emptyOutDir: true,
    rollupOptions: { input: 'index-electron.html' },
  },
  test: { include: [] },
});
