import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
  // Ceilings, not waits: every test awaits an explicit signal, so these only bound a hang. The default 5 s is too
  // tight for a cold child process or a React flow when the whole suite shares a loaded machine.
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], testTimeout: 30_000, hookTimeout: 30_000 },
});
