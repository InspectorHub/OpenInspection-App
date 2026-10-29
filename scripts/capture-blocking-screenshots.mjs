import assert from 'node:assert/strict';
import { access, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const output = fileURLToPath(new URL('../.superpowers/sdd/plan-d2-windows-electron/screenshots/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const origin = server.resolvedUrls?.local?.[0];
assert.ok(origin, 'Vite dev server did not expose a local URL');
let executablePath = chromium.executablePath();
try { await access(executablePath); }
catch {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const versions = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const version of versions) {
    for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const candidate = join(cache, version, relative);
      try { await access(candidate); executablePath = candidate; break; } catch { /* try the other layout */ }
    }
    if (executablePath !== chromium.executablePath()) break;
  }
}
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  for (const reason of ['key-unreadable', 'encryption-unavailable', 'corrupt']) {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${origin}e2e-electron/fixtures/blocking.html?reason=${reason}`);
      await page.getByRole('heading', { level: 1 }).waitFor();
      if (reason === 'key-unreadable') {
        await page.getByText('This Windows account cannot unlock the data stored on this computer').waitFor();
      } else if (reason === 'encryption-unavailable') {
        await page.getByText('Database encryption is unavailable on this computer. Your data has not been changed.').waitFor();
        await page.getByRole('button', { name: 'Open data folder' }).click();
        assert.deepEqual(await page.evaluate(() => window.__actions), ['open-data-folder']);
      } else {
        await page.getByText('The local data could not be read. Your data has not been changed.').waitFor();
        await page.getByRole('button', { name: 'Open data folder' }).click();
        assert.deepEqual(await page.evaluate(() => window.__actions), ['open-data-folder']);
      }
      await page.screenshot({ path: `${output}${reason}-${theme}.png`, fullPage: true });
      if (reason === 'key-unreadable') {
        const opener = page.getByRole('button', { name: 'Set the old data aside and start fresh' });
        await opener.click();
        const dialog = page.getByRole('alertdialog');
        await dialog.waitFor();
        assert.equal(await page.getByRole('button', { name: 'Cancel' }).evaluate((element) => element === document.activeElement), true);
        await page.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
        await opener.click();
        await page.getByRole('button', { name: 'Set old data aside' }).click();
        assert.deepEqual(await page.evaluate(() => window.__actions), ['set-aside']);
      }
    }
  }
  console.log(`Inspected screenshot set written to ${output}`);
} finally {
  await browser.close();
  await server.close();
}
