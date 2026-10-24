import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
