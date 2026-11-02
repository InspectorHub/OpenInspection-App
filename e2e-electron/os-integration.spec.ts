import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/**
 * What the app asks the operating system to do while uploads run, observed by spying on the Electron APIs in the main
 * process. The OS taskbar and the notification centre cannot be seen from here: these tests prove the requests, not the pixels.
 *
 * Uploads run in the MAIN process (electron/main/net/uploader-host.ts). The renderer only queues rows and reconciles them, so
 * a network failure is injected at the loopback engine (or at the page, for the renderer's own online flag).
 */

const PHOTOS = 50;
const START_BUTTON = 'Start 50-photo restart test';
const COUNTER = 'check-desktop-kill-start';

interface ProgressCall { value: number; mode: string | null; at: number }
interface NotificationCall { title: string; body: string; at: number }
interface Spies { progress: ProgressCall[]; notifications: NotificationCall[]; blockers: number[]; powerEvents: string[] }

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
// Forget the harness once disposed, so a startDesktopHarness that throws in the next beforeEach cannot make this hook dispose
// the previous test's harness twice. (A launch that throws inside the harness leaks its own processes; that is the harness's to fix.)
test.afterEach(async () => {
  const current = desktop as DesktopHarness | undefined;
  desktop = undefined as unknown as DesktopHarness;
  const engineErrors = current?.engine.errors ?? [];
  await current?.dispose();
  expect(engineErrors, 'unexpected request-body read errors on the loopback engine').toEqual([]);
});

/** Wraps the Electron calls once per launch. Notification#show and the power-save blocker are recorded WITHOUT reaching the OS. */
async function installSpies(app: ElectronApplication, focused: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow, Notification, powerSaveBlocker }, initialFocus) => {
    const spies: Spies = { progress: [], notifications: [], blockers: [], powerEvents: [] };
    Reflect.set(globalThis, '__osSpies', spies);
    Reflect.set(globalThis, '__osFocused', initialFocus);
    const win = BrowserWindow.getAllWindows()[0]!;
    const originalProgress = win.setProgressBar.bind(win);
    win.setProgressBar = (value: number, options?: { mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused' }) => {
      spies.progress.push({ value, mode: options?.mode ?? null, at: Date.now() });
      originalProgress(value, options);
    };
    // The main process asks `win.isFocused()` at the moment an upload batch drains; a stub makes focus deterministic.
    win.isFocused = () => Reflect.get(globalThis, '__osFocused') === true;
    // The app captured the Notification CLASS when the window was created, so patch the prototype the instances share.
    const proto = Notification.prototype as unknown as { show(this: { title: string; body: string }): void };
    proto.show = function recordShow(this: { title: string; body: string }) { spies.notifications.push({ title: this.title, body: this.body, at: Date.now() }); };
    const originalStart = powerSaveBlocker.start.bind(powerSaveBlocker);
    powerSaveBlocker.start = (type) => { spies.blockers.push(Date.now()); return originalStart(type); };
  }, focused);
}

const spies = (app: ElectronApplication): Promise<Spies> => app.evaluate(() => Reflect.get(globalThis, '__osSpies') as Spies);
const setFocused = (app: ElectronApplication, focused: boolean): Promise<void> => app.evaluate((_, value) => { Reflect.set(globalThis, '__osFocused', value); }, focused);
const emitPower = (app: ElectronApplication, event: 'suspend' | 'resume'): Promise<void> => app.evaluate(({ powerMonitor }, name) => {
  (Reflect.get(globalThis, '__osSpies') as Spies).powerEvents.push(`${name}@${String(Date.now())}`);
  (powerMonitor as unknown as { emit(event: string): boolean }).emit(name);
}, event);

/**
 * Queues the 50 photos. The diagnostics check only stores the rows; the reconciler picks them up on a trigger (a network
 * 'online' event, a foreground change, a retry timer), not on the store write, so by default this fires the same 'online'
 * event the OS sends when a link comes up. Pass kick=false to leave the rows waiting.
 */
async function startBatch(kick = true): Promise<void> {
  await desktop.page.getByRole('button', { name: START_BUTTON }).click();
  await expect(desktop.page.getByTestId(COUNTER)).toContainText('kill=', { timeout: 30_000 });
  if (kick) await desktop.page.evaluate(() => window.dispatchEvent(new Event('online')));
}

const counterText = (): Promise<string> => desktop.page.getByTestId(COUNTER).innerText();

/** Row counts per state straight from the device database; the diagnostics counter stops refreshing at the first moment nothing is pending. */
async function mediaStates(): Promise<Record<string, number>> {
  const rows = await desktop.page.evaluate(() => window.oiDesktop.db.query("SELECT state, COUNT(*) AS n FROM media WHERE pending_id LIKE 'diag-%' GROUP BY state"));
  return Object.fromEntries((rows as Array<{ state: string; n: number }>).map((row) => [row.state, Number(row.n)]));
}

async function finishedBatch(timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    if (desktop.engine.completedCounts.size !== PHOTOS) return false;
    const states = await mediaStates();
    return (states.pending ?? 0) + (states.uploading ?? 0) + (states.failed ?? 0) === 0;
  }, { timeout, intervals: [250] }).toBe(true);
}

/**
 * Every photo arrived and no row is stuck. After a suspend abort a photo may legitimately be sent twice (the abort can land after
 * the server wrote its 201 but before the client read it), so with allowResend a count of 2 is annotated, not failed.
 */
async function expectEveryPhotoDelivered(allowResend: boolean): Promise<void> {
  const engine = desktop.engine;
  expect(engine.completedCounts.size, 'distinct photos completed on the engine').toBe(PHOTOS);
  const repeats = [...engine.completedCounts.entries()].filter(([, count]) => count > 1);
  if (repeats.length > 0) test.info().annotations.push({ type: 'photos-completed-more-than-once', description: String(repeats.length) });
  expect(repeats.filter(([, count]) => count > (allowResend ? 2 : 1)), 'photos completed more often than allowed').toEqual([]);
  expect(engine.uploads.size).toBe(PHOTOS);
  expect([...engine.uploads.values()].every((bytes) => bytes.length > 0)).toBe(true);
  const states = await mediaStates();
  expect((states.pending ?? 0) + (states.uploading ?? 0) + (states.failed ?? 0), `rows left in a non-final state: ${JSON.stringify(states)}`).toBe(0);
}

/** Runs a whole batch under the taskbar spy and returns every value the spy saw. */
async function progressBatch(): Promise<number[]> {
  await installSpies(desktop.app, true);
  await desktop.openDiagnostics();
  await startBatch();
  await finishedBatch();
  await expect.poll(async () => (await spies(desktop.app)).progress.at(-1)?.value, { timeout: 10_000 }).toBe(-1);
  return (await spies(desktop.app)).progress.map((call) => call.value);
}

// ---------------------------------------------------------------------------------------------------------------------
// A. Taskbar progress (electron/main/lifecycle/taskbar.ts, wired at electron/main/index.ts createTaskbarProgress)
// ---------------------------------------------------------------------------------------------------------------------
test.describe('A. taskbar progress', () => {
  test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 400, quitAnswer: 'quit' }); });

  test('setProgressBar: silent with no uploads, 0..1 while a batch runs, cleared when it ends', async () => {
    test.setTimeout(90_000);
    await installSpies(desktop.app, true);
    // Negative control: an idle app must not touch the taskbar.
    await desktop.page.waitForTimeout(1500);
    expect((await spies(desktop.app)).progress, 'no upload, no progress call').toEqual([]);

    await desktop.openDiagnostics();
    await startBatch();
    await finishedBatch();
    await expect.poll(async () => (await spies(desktop.app)).progress.at(-1)?.value, { timeout: 10_000 }).toBe(-1);

    const calls = (await spies(desktop.app)).progress;
    const values = calls.map((call) => call.value);
    test.info().annotations.push({ type: 'progress-values', description: values.map((v) => v.toFixed(2)).join(' ') });
    expect(values.length, 'positive control: the spy saw calls').toBeGreaterThanOrEqual(1);
    expect(values.every((value) => Number.isFinite(value) && (value === -1 || (value >= 0 && value <= 1))), `values out of range: ${values.join(',')}`).toBe(true);
    expect(new Set(values.filter((value) => value >= 0).map((value) => value.toFixed(2))).size, 'distinct progress values (4 MiB photos give many steps; two is the floor for a slow runner)').toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toMatchObject({ value: -1, mode: 'none' });
    expect(calls.filter((call) => call.mode === 'error'), 'a clean batch never shows the error colour').toEqual([]);
  });

  // Progress is completed/total over the batch with a high-water mark (electron/main/lifecycle/batch.ts), so it never moves backwards.
  test('setProgressBar never goes backwards inside one batch', async () => {
    test.setTimeout(120_000);
    const all = await progressBatch();
    expect(all.length, 'spy installed and saw calls').toBeGreaterThan(0);
    const values = all.filter((value) => value >= 0);
    const drops = values.filter((value, index) => index > 0 && value < values[index - 1]! - 1e-9).length;
    test.info().annotations.push({ type: 'progress-drops', description: `${String(drops)} drops in ${String(values.length)} calls` });
    expect(drops, 'times the bar moved backwards').toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// B. Completion notification (electron/main/lifecycle/notify.ts: none while focused, at most one per 10 minutes)
// ---------------------------------------------------------------------------------------------------------------------
test.describe('B. notification when uploads finish', () => {
  test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 150, quitAnswer: 'quit' }); });

  test('focused window: no notification when the batch drains', async () => {
    test.setTimeout(90_000);
    await installSpies(desktop.app, true);
    await desktop.openDiagnostics();
    await startBatch();
    await finishedBatch();
    await desktop.page.waitForTimeout(1000);
    const seen = await spies(desktop.app);
    expect(seen.blockers.length, 'positive control: uploads really ran (power-save blocker taken)').toBeGreaterThanOrEqual(1);
    expect(seen.notifications, 'focused window: no notification').toEqual([]);
  });

  test('unfocused window: exactly one notification for the whole batch, however many times the count touched zero', async () => {
    test.setTimeout(90_000);
    await installSpies(desktop.app, false);
    await desktop.openDiagnostics();
    await startBatch();
    await expect.poll(async () => (await spies(desktop.app)).notifications.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await finishedBatch();
    await desktop.page.waitForTimeout(1500);
    const seen = await spies(desktop.app);
    // Every 0 -> n transition of the active count takes the power-save blocker once, so this is the number of "waves" (each
    // wave ends in a drain that asks the notifier). More than one wave and still one notification = the 10-minute throttle held.
    test.info().annotations.push({ type: 'upload-waves', description: String(seen.blockers.length) });
    test.info().annotations.push({ type: 'notifications', description: JSON.stringify(seen.notifications.map((call) => call.body)) });
    expect(seen.notifications, 'exactly one notification for a 50-photo batch, not one per photo').toHaveLength(1);
    expect(seen.notifications[0]).toMatchObject({ title: 'InspectorHub', body: 'InspectorHub: uploads finished' });
  });
});

test.describe('B2. notification timing', () => {
  test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 150, quitAnswer: 'quit' }); });

  // The batch reports idle only after the active count stayed at 0 past a grace window (batch.ts), so the gaps between the
  // renderer's upload waves do not fire the notification and the throttle slot is not spent early.
  test('the notification waits until every photo is uploaded', async () => {
    test.setTimeout(120_000);
    await installSpies(desktop.app, false);
    await desktop.openDiagnostics();
    await startBatch();
    await expect.poll(async () => (await spies(desktop.app)).notifications.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    const at = (await spies(desktop.app)).notifications[0]!.at;
    await finishedBatch();
    expect(desktop.engine.completedCounts.size, 'all 50 photos finished').toBe(PHOTOS);
    const completedBefore = desktop.engine.completedAt.filter((time) => time <= at).length;
    test.info().annotations.push({ type: 'completed-when-notified', description: `${String(completedBefore)} of ${String(PHOTOS)}` });
    expect(completedBefore, 'photos already uploaded when the notification appeared').toBe(PHOTOS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// C. Sleep and wake (electron/main/lifecycle/power.ts: suspend aborts every upload, resume re-activates the renderer)
// ---------------------------------------------------------------------------------------------------------------------
test.describe('C. sleep and wake during a batch', () => {
  test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 500, quitAnswer: 'quit' }); });

  async function midBatch(): Promise<void> {
    await installSpies(desktop.app, true);
    await desktop.openDiagnostics();
    await startBatch();
    await expect.poll(() => desktop.engine.completedCounts.size, { timeout: 30_000, intervals: [100] }).toBeGreaterThanOrEqual(8);
    expect(desktop.engine.completedCounts.size, 'still mid-batch when the machine sleeps').toBeLessThan(PHOTOS - 8);
  }

  test('suspend then resume on a healthy network: in-flight uploads are aborted and finish later, none lost', async () => {
    test.setTimeout(240_000);
    await midBatch();
    const inFlight = desktop.engine.activeUploadCount;
    await emitPower(desktop.app, 'suspend');
    // The reconciler restarts uploads at once, so the count may only dip, not rest at 0. Sampled every 20 ms it must fall below
    // what was in flight: that proves the abort. Weaker than "reaches 0" on purpose, and says so if nothing was in flight.
    if (inFlight >= 1) await expect.poll(() => desktop.engine.activeUploadCount < inFlight, { timeout: 10_000, intervals: [20] }).toBe(true);
    else test.info().annotations.push({ type: 'suspend-abort-unproven', description: 'no upload was in flight at the suspend' });
    const frozenAt = desktop.engine.completedCounts.size;
    await desktop.page.waitForTimeout(1500);
    // Observed, not asserted: a simulated suspend does not freeze this process, and the app only aborts what is in flight, so
    // the renderer's reconciler keeps starting new uploads. A real sleep freezes everything, so this is not a user-visible fault.
    test.info().annotations.push({ type: 'completed-while-"asleep"', description: String(desktop.engine.completedCounts.size - frozenAt) });
    const resumedAt = Date.now();
    await emitPower(desktop.app, 'resume');
    await finishedBatch(120_000);
    const recovery = Date.now() - resumedAt;
    test.info().annotations.push({ type: 'recovery-after-resume-ms', description: String(recovery) });
    await expectEveryPhotoDelivered(true);
    expect((await spies(desktop.app)).blockers.length, 'the power-save blocker was taken while uploading').toBeGreaterThanOrEqual(1);
  });

  test('suspend, the network drops while asleep, resume when it is back: nothing lost', async () => {
    test.setTimeout(240_000);
    await midBatch();
    await emitPower(desktop.app, 'suspend');
    desktop.engine.setUnavailable(true);
    await expect.poll(() => desktop.engine.activeUploadCount, { timeout: 10_000 }).toBe(0);
    const frozenAt = desktop.engine.completedCounts.size;
    // Negative control: while the network is gone and the machine asleep, nothing completes.
    await desktop.page.waitForTimeout(3000);
    expect(desktop.engine.completedCounts.size, 'no progress while the network is down').toBe(frozenAt);
    desktop.engine.setUnavailable(false);
    const resumedAt = Date.now();
    await emitPower(desktop.app, 'resume');
    await finishedBatch(120_000);
    const recovery = Date.now() - resumedAt;
    test.info().annotations.push({ type: 'recovery-after-resume-ms', description: String(recovery) });
    await expectEveryPhotoDelivered(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// D. Real offline states (src/desktop/network-browser.ts + src/ui/worklist/useOnline.ts read navigator.onLine only)
// ---------------------------------------------------------------------------------------------------------------------
test.describe('D. offline', () => {
  test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 100, quitAnswer: 'quit' }); });

  const chip = () => desktop.page.locator('span', { hasText: /^(Online|Offline|Server unreachable|Sync paused)$/ }).first();

  test('D1 page-level offline: the chip says Offline, photos stay pending and unsent, then the queue drains once each', async () => {
    test.setTimeout(120_000);
    await expect(chip()).toHaveText('Online');
    await desktop.page.context().setOffline(true);
    expect(await desktop.page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(chip()).toHaveText('Offline');
    const requestsBefore = desktop.engine.requests.length;

    await desktop.openDiagnostics();
    await startBatch(false);
    await expect(desktop.page.getByTestId(COUNTER)).toContainText(`kill=running done=0 of=${String(PHOTOS)}`, { timeout: 30_000 });
    // The reconciler listens to the window 'online' event (network-browser.ts), then asks navigator.onLine and bows out when it
    // is false. Fire it (plus focus and visibilitychange) repeatedly while offline: nothing may be sent, because the gate is
    // the offline check, not the absence of a trigger.
    for (let round = 0; round < 6; round += 1) {
      await desktop.page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await desktop.page.waitForTimeout(500);
    }
    expect(await desktop.page.evaluate(() => navigator.onLine), 'still offline after the triggers').toBe(false);
    expect(await counterText()).toContain(`pending=${String(PHOTOS)}`);
    expect(desktop.engine.uploadCounts.size, 'nothing reached the engine while offline').toBe(0);
    expect(desktop.engine.requests.slice(requestsBefore).filter((line) => /upload|media/.test(line)), 'no upload traffic while offline').toEqual([]);

    await desktop.page.context().setOffline(false);
    await expect(chip()).toHaveText('Online');
    // Positive control: the same trigger with the network up DOES send, so the zero above came from the offline gate.
    await desktop.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => desktop.engine.uploadCounts.size, { timeout: 30_000 }).toBeGreaterThan(0);
    await finishedBatch(90_000);
    await expectEveryPhotoDelivered(false);
    expect([...desktop.engine.uploadCounts.values()].every((count) => count === 1), 'one attempt each').toBe(true);
  });

  /** Takes the engine down with the OS still online and waits for the grey server line; returns its text. */
  async function serverOutage(): Promise<string> {
    await expect(chip()).toHaveText('Online');
    desktop.engine.setUnavailable(true);
    await desktop.page.getByRole('button', { name: "Download today's work" }).click();
    const line = desktop.page.getByTestId('server-line');
    await expect.poll(async () => (await line.innerText()).trim(), { timeout: 30_000 }).toMatch(/can't be reached|Sync is paused/);
    const text = (await line.innerText()).trim();
    test.info().annotations.push({ type: 'server-line-with-engine-down', description: text });
    expect(await desktop.page.evaluate(() => navigator.onLine), 'the OS/page still reports a link').toBe(true);
    return text;
  }

  test('D2 server-level outage with the OS online: the grey server line says so, and clears on recovery', async () => {
    test.setTimeout(90_000);
    await serverOutage();
    desktop.engine.setUnavailable(false);
    await desktop.page.getByRole('button', { name: "Download today's work" }).click();
    await expect.poll(async () => (await desktop.page.getByTestId('server-line').innerText()).trim(), { timeout: 30_000 }).toBe('');
  });

  // The chip folds in server reachability (src/ui/worklist/connection.ts): a dead server never reads as a green Online.
  test('the chip does not claim Online while the server is unreachable', async () => {
    test.setTimeout(90_000);
    await serverOutage();
    await expect(chip(), 'status chip while the server line says it cannot be reached').not.toHaveText('Online', { timeout: 2000 });
  });
});
