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
  projects: [
    // The visual baselines are made and compared on one runner only (the visual-baselines workflow), so the sharded `ci` run skips them.
    { name: 'ci', testIgnore: ['**/*.local.spec.ts', '**/*.visual.spec.ts'] },
    { name: 'local', testMatch: '**/*.local.spec.ts' },
    { name: 'visual', testMatch: '**/*.visual.spec.ts' },
  ],
  // One flat folder of baselines, named by screen, theme and width, with the platform in the name so a Linux or macOS run can never be
  // mistaken for the Windows baselines it would be compared against.
  snapshotPathTemplate: '{testDir}/visual-baselines/{arg}-{platform}{ext}',
});
