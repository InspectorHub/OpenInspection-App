import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// The renderer's own <title> overrides the BrowserWindow title once the page loads, so the two must name the
// same product or the title bar and the taskbar tooltip show whichever the page says.
it('the renderer page title matches the window title', () => {
  const windowSource = readFileSync(resolve('electron/main/window.ts'), 'utf8');
  const windowTitle = /title:\s*'([^']+)'/.exec(windowSource)?.[1];
  const pageTitle = /<title>([^<]*)<\/title>/.exec(readFileSync(resolve('index-electron.html'), 'utf8'))?.[1];
  expect(windowTitle).toBeTruthy();
  expect(pageTitle).toBe(windowTitle);
});
