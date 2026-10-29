import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '../.superpowers/sdd/plan-d2-windows-electron/test-results',
  projects: [{ name: 'ci' }],
});
