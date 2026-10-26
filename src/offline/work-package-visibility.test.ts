import { beforeEach, describe, expect, it } from 'vitest';
import { jsonReply, createPackageWorld, type PackageWorld } from './test-support/package-world';
import { readPackageStates } from './work-package';
import { ALICE } from './test-support/replay-world';

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld({ limits: { maxConsecutiveErrors: 1 } });
});

const lists = (): number => w.pkg.requests.filter((r) => r.path === '/api/inspections').length;
const markers = (): Promise<{ package_id: string; body: string }[]> => w.db.query("SELECT package_id, body FROM resource_cache WHERE key LIKE '$refresh_error:%' ORDER BY package_id");

describe('a pinned inspection the server does not show to this person', () => {
  it.each([
    ['404', 404],
    ['403', 403],
  ])('%s on the inspection read: one request, skipped quietly, a not_visible marker, no failure and no halt', async (_name, status) => {
    await w.seed('ghost', { pinned: 1 });
    w.serve('real');
    w.pkg.overrides.set('/api/inspections/ghost', () => jsonReply(status, { success: false, error: { code: 'NOT_FOUND', message: 'gone' } }));
    const summary = await w.run('manual');
    expect(w.pkg.forInspection('ghost')).toEqual(['/api/inspections/ghost']);
    expect(summary).toMatchObject({ failed: 0, notVisible: 1, halted: null, refreshed: 1 });
    expect(await markers()).toEqual([{ package_id: 'ghost', body: 'not_visible' }]);
    expect((await readPackageStates(w.db, ALICE)).find((s) => s.inspectionId === 'ghost')?.lastError).toBe('not_visible');
  });

  it('two of them in a row do not trip the consecutive-error halt (the limit here is 1)', async () => {
    await w.seed('g1', { pinned: 1 });
    await w.seed('g2', { pinned: 1 });
    w.serve('real');
    const summary = await w.run('manual');
    expect(summary).toMatchObject({ notVisible: 2, failed: 0, halted: null, refreshed: 1 });
  });

  it('is not asked about again by a background run within the freshness window, and is asked again by a person', async () => {
    await w.seed('ghost', { pinned: 1 });
    await w.run('manual');
    w.clock.advance(60_000);
    w.pkg.requests.length = 0;
    const background = await w.run('fallback');
    expect(w.pkg.forInspection('ghost')).toEqual([]);
    expect(background.notVisible).toBe(0);
    await w.run('manual');
    expect(w.pkg.forInspection('ghost')).toEqual(['/api/inspections/ghost']);
  });

  it('is asked about again by a background run once the freshness window has passed', async () => {
    await w.seed('ghost', { pinned: 1 });
    await w.run('manual');
    w.clock.advance(400_000);
    w.pkg.requests.length = 0;
    await w.run('fallback');
    expect(w.pkg.forInspection('ghost')).toEqual(['/api/inspections/ghost']);
  });

  it('control: a 404 on an optional read still means it does not apply, and a 403 on a required read is still a failure', async () => {
    w.serve('t1');
    await w.run('manual');
    w.pkg.overrides.set('/api/inspections/t1/results', () => jsonReply(403, { success: false }));
    const summary = await w.run('manual');
    expect(summary).toMatchObject({ failed: 1, notVisible: 0 });
    expect(await markers()).toEqual([{ package_id: 't1', body: 'refused' }]);
  });
});

describe('list queries are debounced for background runs', () => {
  it('two background runs close together make one list cycle (four list requests), the second changes nothing', async () => {
    w.serve('t1');
    await w.run('online');
    expect(lists()).toBe(4);
    const again = await w.run('foreground');
    expect(lists()).toBe(4);
    expect(again).toMatchObject({ refreshed: 0, failed: 0, halted: null, leaseBusy: false, requests: 0 });
  });

  it('the online and foreground triggers that arrive together make one cycle, not two', async () => {
    w.serve('t1');
    w.refresher.trigger('online');
    w.refresher.trigger('foreground');
    await w.refresher.idle();
    expect(lists()).toBe(4);
  });

  it('a person asking bypasses the debounce', async () => {
    w.serve('t1');
    await w.run('online');
    await w.run('manual');
    expect(lists()).toBe(8);
  });

  it('after the window a background run lists again', async () => {
    w.serve('t1');
    await w.run('online');
    w.clock.advance(31_000);
    await w.run('foreground');
    expect(lists()).toBe(8);
  });

  it('a list cycle that did not complete (halted) does not start the window', async () => {
    w.serve('t1');
    w.pkg.script.push(jsonReply(500, { success: false }), jsonReply(500, { success: false }), jsonReply(500, { success: false }));
    const first = await w.run('online');
    expect(first.halted).not.toBeNull();
    const before = lists();
    await w.run('foreground');
    expect(lists()).toBeGreaterThan(before);
  });

  it('another account is not held back by the first one\'s window', async () => {
    w.serve('t1');
    await w.run('online');
    w.state.account = { tenantId: 'tenant-2', userId: 'carol' };
    await w.run('foreground');
    expect(lists()).toBe(8);
  });
});
