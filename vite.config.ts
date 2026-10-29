import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { parseBuiltAt } from './src/platform/build-info.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The build instant the iOS test-build expiry warning counts from. `APP_BUILT_AT` (a UTC ISO instant) makes a build reproducible.
// A value that is not a real instant stops the build: a damaged date would silently switch the warning off.
const builtAt = process.env.APP_BUILT_AT ?? new Date().toISOString();
if (parseBuiltAt(builtAt) === null) throw new Error(`APP_BUILT_AT is not a UTC ISO instant: ${builtAt}`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILT_AT__: JSON.stringify(builtAt) },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
  // Ceilings, not waits: every test awaits an explicit signal, so these only bound a hang. The default 5 s is too
  // tight for a cold child process or a React flow when the whole suite shares a loaded machine.
  // field-ui keeps two bare `.css` imports of its third-party stylesheets in its built entry; node cannot load those, so the
  // test runner builds the package through vite like the app's own bundle does.
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], testTimeout: 30_000, hookTimeout: 30_000, server: { deps: { inline: ['@inspectorhub/field-ui'] } } },
});
