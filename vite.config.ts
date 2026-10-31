import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { buildDefines } from './vite.defines.ts';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: buildDefines(),
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
  // Ceilings, not waits: every test awaits an explicit signal, so these only bound a hang. The default 5 s is too
  // tight for a cold child process or a React flow when the whole suite shares a loaded machine.
  // field-ui keeps two bare `.css` imports of its third-party stylesheets in its built entry; node cannot load those, so the
  // test runner builds the package through vite like the app's own bundle does.
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts', 'scripts/**/*.test.ts', 'e2e/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000, server: { deps: { inline: ['@inspectorhub/field-ui'] } } },
});
