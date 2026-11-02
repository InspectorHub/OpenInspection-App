import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { prepareDesktopRenderer, seedEditorPackage, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/**
 * LAYOUT regression only. These screenshots catch a screen that moved, overflowed, lost its theme or collapsed at a narrow width. They do
 * not say a screen is right (a person looks at it once, when its baseline is first created), they do not check behaviour (the other specs
 * do), and they say nothing about fonts or colour management on any machine but the one that made the baselines: the baselines are made by
 * the visual-baselines workflow on a windows-latest runner and compared only there. The `visual` project in playwright.config.ts runs this
 * file; the `ci` project ignores it. See "Visual layout baselines" in docs/development.md.
 *
 * Five screens, each in light and dark, wide and narrow: the work list, the editor, Settings, the export dialog and the blocking pages.
 */

const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { key: 'wide', width: 1280, height: 800 },
  { key: 'narrow', width: 480, height: 720 },
] as const;
type Theme = (typeof THEMES)[number];

/** Same options everywhere. A small tolerance absorbs anti-aliasing; a moved or resized block is far above it. */
const SHOT = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01 } as const;

async function applyTheme(page: Page, theme: Theme, setNative?: (theme: Theme) => Promise<void>): Promise<void> {
  await setNative?.(theme);
  await page.emulateMedia({ colorScheme: theme });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
}

/**
 * Three texts change from run to run and from day to day: the fake engine's random port, today's date under "Last verified", and how
 * long ago the last check was. A mask would still leave their width to decide the diff, so they are rewritten to fixed text of the same
 * kind before the screenshot: the layout is compared, the values are not.
 */
async function freezeChangingText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rules: Array<[RegExp, string]> = [
      [/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:50000'],
      [/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g, 'January 15, 2026'],
      [/Checked (?:this minute|just now|\d+ minutes? ago)/g, 'Checked this minute'],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      let text = node.nodeValue ?? '';
      for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  });
}

/** Takes the screen in every theme and width. `name` is the baseline's stem, for example `settings`. */
async function captureMatrix(page: Page, name: string, setNative?: (theme: Theme) => Promise<void>, position: 'top' | 'bottom' = 'top'): Promise<void> {
  for (const theme of THEMES) {
    await applyTheme(page, theme, setNative);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 'bottom' shows the end of a long page (Settings: the "Your data" controls). The scroll comes after the resize, which resets it.
      await page.evaluate((to) => window.scrollTo(0, to === 'bottom' ? document.documentElement.scrollHeight : 0), position);
      await freezeChangingText(page);
      await expect(page).toHaveScreenshot(`${name}-${theme}-${viewport.key}.png`, SHOT);
    }
  }
}

test.describe('app screens in the desktop window', () => {
  let desktop: DesktopHarness | undefined;
  test.beforeAll(prepareDesktopRenderer);
  test.afterAll(async () => { await desktop?.dispose(); });

  test('work list, Settings, export dialog and editor keep their layout', async () => {
    test.setTimeout(240_000);
    desktop = await startDesktopHarness({ quitAnswer: 'quit' });
    const { page } = desktop;
    const harness = desktop;
    // `harness.app` is read each time: the app is restarted halfway, and the theme must go to the running one.
    const setNative = async (theme: Theme) => { await harness.app.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme); };
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();
    await expect(page.getByText('Online', { exact: true })).toBeVisible();
    await captureMatrix(page, 'work-list', setNative);

    // The editor's own flow (and the editor's button names) is the one the other specs drive: wide and light, as they leave it.
    await applyTheme(page, 'light', setNative);
    await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
    await seedEditorPackage(page);
    await captureMatrix(page, 'editor', setNative);

    // Back on the work list by restarting the app, as the photo-cache spec does; the editor has no way out that this spec needs.
    await desktop.restartGracefully();
    const restarted = desktop.page;
    await restarted.getByRole('button', { name: 'Settings' }).click();
    await expect(restarted.getByRole('heading', { name: 'Desktop app' })).toBeVisible();
    await captureMatrix(restarted, 'settings', setNative);
    // The same page scrolled to its end, where "Your data" holds Export unsent data and Import package.
    await restarted.getByText('Your data', { exact: true }).scrollIntoViewIfNeeded();
    await captureMatrix(restarted, 'settings-bottom', setNative, 'bottom');

    // The export dialog, opened from Settings. Nothing is waiting on this device, so it shows the one-line "Nothing to export" answer.
    await restarted.getByRole('button', { name: 'Export unsent data' }).click();
    await expect(restarted.getByText('Nothing to export').first()).toBeVisible();
    await captureMatrix(restarted, 'export', setNative);
  });
});

test.describe('blocking pages', () => {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let origin = '';
  test.beforeAll(async () => {
    server = await createServer({ configFile: resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    origin = server.resolvedUrls?.local?.[0] ?? '';
    if (origin === '') throw new Error('the Vite dev server did not expose a local URL');
    // CI installs the pinned Chromium (`npx playwright install chromium`). A machine that holds only an older download can point at it.
    browser = await chromium.launch({ headless: true, executablePath: process.env.OI_VISUAL_CHROMIUM });
  });
  test.afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const SCREENS = [
    { name: 'blocking-key-unreadable', query: 'reason=key-unreadable', heading: undefined },
    { name: 'blocking-encryption-unavailable', query: 'reason=encryption-unavailable', heading: undefined },
    { name: 'blocking-corrupt', query: 'reason=corrupt', heading: undefined },
    { name: 'blocking-db-key-lost', query: 'screen=db-key-lost', heading: 'This device cannot read its saved data' },
  ] as const;

  for (const screen of SCREENS) {
    test(`${screen.name} keeps its layout`, async () => {
      const context = await browser!.newContext({ deviceScaleFactor: 1 });
      const page = await context.newPage();
      try {
        // The fixture reads the colour scheme once when it loads, so each theme is a fresh load rather than a media switch.
        for (const theme of THEMES) {
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${origin}e2e-electron/fixtures/blocking.html?${screen.query}`);
          await expect(page.getByRole('heading', { level: 1, name: screen.heading })).toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
          for (const viewport of VIEWPORTS) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await expect(page).toHaveScreenshot(`${screen.name}-${theme}-${viewport.key}.png`, SHOT);
          }
        }
      } finally {
        await context.close();
      }
    });
  }
});
