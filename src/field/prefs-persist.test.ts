import { describe, expect, it } from 'vitest';
import { accountKey } from '../offline/outbox';
import type { Db } from '../platform/db';
import { clearLocalData } from '../offline/clear-local-data';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { MESSAGES } from './messages';
import { createPrefs, DEFAULT_INSPECTION_PREFS } from './resources-library';
import { resourceWorld, type ResourceWorld } from './test-support/resource-world';
import { reply } from './test-support/scripted-api';
import { ALICE, BOB } from './test-support/seed-package';

const ROUTE = '/api/tenant/inspection-prefs';
const keyOf = (account: typeof ALICE): string => `inspection_prefs:${accountKey(account)}`;

interface Stored {
  prefs: Record<string, unknown> | null;
  pending: Record<string, unknown>;
}

async function stored(db: Db, account: typeof ALICE = ALICE): Promise<Stored | null> {
  const rows = await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [keyOf(account)]);
  const row = rows[0];
  return row === undefined ? null : (JSON.parse(row.value) as Stored);
}

/** A restart: the same database, a new prefs object with no memory of its own. */
const restart = (w: ResourceWorld) => createPrefs(w.deps);

describe('prefs persistence: the last value read survives', () => {
  it('the built-in default is keyboard, the same as the web editor and the server (a company that never changed it)', () => {
    expect(DEFAULT_INSPECTION_PREFS.autoAdvance).toBe('keyboard');
  });

  it('after a failed load the persisted company value is used, not the built-in default', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off' }), reply(500)] });
    expect((await createPrefs(w.deps).load()).autoAdvance).toBe('off');
    // control: the default is something else, so "off" can only have come from the stored copy
    expect(DEFAULT_INSPECTION_PREFS.autoAdvance).not.toBe('off');
    expect((await restart(w).load()).autoAdvance).toBe('off');
    expect(w.api.calls).toHaveLength(2);
  });

  it('offline after a cold start the persisted value is used and nothing is requested', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'always', pinnedTagIds: ['t1'] })] });
    await createPrefs(w.deps).load();
    w.state.online = false;
    expect(await restart(w).load()).toEqual({ ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'always', pinnedTagIds: ['t1'] });
    expect(w.api.calls).toHaveLength(1);
  });

  it('first ever load: offline and failed both answer the default (control: a stored value would win)', async () => {
    const off = await resourceWorld({ online: false });
    expect(await restart(off).load()).toEqual(DEFAULT_INSPECTION_PREFS);
    const failed = await resourceWorld({ answers: [reply(500)] });
    expect(await restart(failed).load()).toEqual(DEFAULT_INSPECTION_PREFS);
    expect(await stored(failed.db)).toBeNull();
  });

  it('an online load overwrites the stored copy', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off' }), reply(200, { autoAdvance: 'keyboard' })] });
    await createPrefs(w.deps).load();
    expect((await stored(w.db))?.prefs?.autoAdvance).toBe('off');
    expect((await restart(w).load()).autoAdvance).toBe('keyboard');
    w.state.online = false;
    expect((await restart(w).load()).autoAdvance).toBe('keyboard');
  });

  it('one account never reads another account\'s copy', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off' })] });
    await createPrefs(w.deps).load();
    w.state.online = false;
    const bob = createPrefs({ ...w.deps, account: BOB });
    expect(await bob.load()).toEqual(DEFAULT_INSPECTION_PREFS);
    // control: alice still has hers
    expect((await createPrefs(w.deps).load()).autoAdvance).toBe('off');
    await bob.patch({ autoAdvance: 'keyboard' });
    expect((await createPrefs(w.deps).load()).autoAdvance).toBe('off');
    expect((await stored(w.db, BOB))?.pending).toEqual({ autoAdvance: 'keyboard' });
    expect((await stored(w.db, ALICE))?.pending).toEqual({});
  });

  it('an unreadable stored value counts as nothing stored', async () => {
    const w = await resourceWorld({ online: false });
    await w.db.run('INSERT INTO device_state (key, value) VALUES (?, ?)', [keyOf(ALICE), '{not json']);
    expect(await restart(w).load()).toEqual(DEFAULT_INSPECTION_PREFS);
    await w.db.run('UPDATE device_state SET value = ? WHERE key = ?', [JSON.stringify({ prefs: { autoAdvance: 'off' }, pending: {} }), keyOf(ALICE)]);
    expect((await restart(w).load()).autoAdvance).toBe('off');
  });
});

describe('prefs persistence: a change made offline', () => {
  it('returns ok with the merged preferences at once, sends nothing, and records only the changed field as pending', async () => {
    const w = await resourceWorld({ online: false });
    const prefs = createPrefs(w.deps);
    expect(await prefs.patch({ autoAdvance: 'keyboard' })).toEqual({ ok: true, data: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'keyboard' } });
    expect(w.api.calls).toHaveLength(0);
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'keyboard' });
    // survives a restart
    expect((await restart(w).load()).autoAdvance).toBe('keyboard');
    // a second field joins the pending set; the first stays
    await prefs.patch({ cloneDefault: 'all' });
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'keyboard', cloneDefault: 'all' });
    // the last write to one field wins
    await prefs.patch({ autoAdvance: 'off' });
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'off', cloneDefault: 'all' });
  });

  it('sits on top of the persisted company value, not the default', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off', pinnedTagIds: ['t1'] })] });
    await createPrefs(w.deps).load();
    w.state.online = false;
    const result = await restart(w).patch({ cloneDefault: 'all' });
    expect(result).toEqual({ ok: true, data: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'off', pinnedTagIds: ['t1'], cloneDefault: 'all' } });
  });

  it('a request that cannot be answered (no connection, a lost answer, a server error) is also kept as pending', async () => {
    for (const answer of [{ kind: 'problem', problem: 'offline' } as const, { kind: 'problem', problem: 'unknown' } as const, reply(503)]) {
      const w = await resourceWorld({ answers: [answer] });
      expect(await createPrefs(w.deps).patch({ autoAdvance: 'off' })).toEqual({ ok: true, data: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'off' } });
      expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'off' });
    }
  });

  it('a refusal online is still a refusal and keeps nothing (control: the unreachable cases above keep it)', async () => {
    const w = await resourceWorld({ answers: [reply(403), reply(422)] });
    const prefs = createPrefs(w.deps);
    expect(await prefs.patch({ agentRepairAccess: 'off' })).toEqual({ ok: false, error: MESSAGES.forbidden });
    expect(await prefs.patch({ autoAdvance: 'off' })).toEqual({ ok: false, error: MESSAGES.prefsNotSaved });
    expect((await stored(w.db))?.pending ?? {}).toEqual({});
  });

  it('a value that is not a valid preference is refused, not kept and not reported as saved', async () => {
    const w = await resourceWorld({ online: false });
    const result = await createPrefs(w.deps).patch({ autoAdvance: 'sideways' } as never);
    expect(result.ok).toBe(false);
    expect((await stored(w.db))?.pending ?? {}).toEqual({});
    expect(w.api.calls).toHaveLength(0);
  });

  it('a change accepted online with an empty answer still replaces an older waiting value for the same field', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(503), reply(204)] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'off' });
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'off' });
    w.state.online = true;
    const result = await prefs.patch({ autoAdvance: 'always' }); // the older send fails with 503, the newer is accepted with no body
    expect(result.ok).toBe(true);
    expect((await stored(w.db))?.pending ?? {}).toEqual({}); // control: before the fix the stale 'off' stayed and was sent later
    await prefs.flush();
    expect(w.api.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2); // no third send of the stale value
  });

  it('a read answered 200 with an object that carries no preference does not replace the stored copy with the defaults', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'off' }), reply(200, {})] });
    expect((await createPrefs(w.deps).load()).autoAdvance).toBe('off');
    expect((await restart(w).load()).autoAdvance).toBe('off');
    expect((await stored(w.db))?.prefs?.autoAdvance).toBe('off');
  });
});

describe('prefs persistence: sending the pending change', () => {
  it('flush sends only the changed fields once the connection is back, then clears the pending change', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(200, { autoAdvance: 'keyboard' })] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'keyboard' });
    await prefs.flush();
    expect(w.api.calls).toHaveLength(0); // control: still offline, nothing went out
    w.state.online = true;
    await prefs.flush();
    expect(w.api.calls).toHaveLength(1);
    expect(w.api.calls[0]).toMatchObject({ method: 'PATCH', path: ROUTE, json: { autoAdvance: 'keyboard' } });
    expect((await stored(w.db))?.pending).toEqual({});
    expect((await stored(w.db))?.prefs?.autoAdvance).toBe('keyboard');
    await prefs.flush();
    expect(w.api.calls).toHaveLength(1); // nothing left to send
  });

  it('load sends the pending change before it reads, and adopts what the server then says', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(200, { autoAdvance: 'off' }), reply(200, { autoAdvance: 'off', pinnedTagIds: ['x'] })] });
    await createPrefs(w.deps).patch({ autoAdvance: 'off' });
    w.state.online = true;
    const loaded = await restart(w).load();
    expect(w.api.calls.map((c) => c.method)).toEqual(['PATCH', 'GET']);
    expect(loaded).toEqual({ ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'off', pinnedTagIds: ['x'] });
    expect((await stored(w.db))?.pending).toEqual({});
  });

  it('a transient failure keeps the pending change and the device keeps showing it', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(503), { kind: 'problem', problem: 'offline' }] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'off' });
    w.state.online = true;
    await prefs.flush();
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'off' });
    expect((await prefs.load()).autoAdvance).toBe('off');
  });

  it('a permanent refusal drops the pending change, and the next load adopts the server value', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(403), reply(200, { autoAdvance: 'always' })] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'off' });
    expect((await prefs.load()).autoAdvance).toBe('off'); // control: while pending the device shows its own value
    w.state.online = true;
    const loaded = await prefs.load();
    expect(w.api.calls.map((c) => c.method)).toEqual(['PATCH', 'GET']);
    expect(loaded.autoAdvance).toBe('always');
    expect((await stored(w.db))?.pending).toEqual({});
    w.state.online = false;
    expect((await restart(w).load()).autoAdvance).toBe('always');
    expect(w.api.calls).toHaveLength(2); // the refused change was not sent again
  });

  it('an unauthorised answer (401) is not a verdict on the change: it stays pending', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(401)] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'off' });
    w.state.online = true;
    await prefs.flush();
    expect((await stored(w.db))?.pending).toEqual({ autoAdvance: 'off' });
  });

  it('an online change first sends an older pending one; the newer value for the same field wins', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(200, { autoAdvance: 'off' }), reply(200, { autoAdvance: 'keyboard' })] });
    const prefs = createPrefs(w.deps);
    await prefs.patch({ autoAdvance: 'off' });
    w.state.online = true;
    const result = await prefs.patch({ autoAdvance: 'keyboard' });
    expect(w.api.calls.map((c) => c.json)).toEqual([{ autoAdvance: 'off' }, { autoAdvance: 'keyboard' }]);
    expect(result).toEqual({ ok: true, data: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'keyboard' } });
    expect((await stored(w.db))?.pending).toEqual({});
  });

  it('an online change is cached from the answer the server gave', async () => {
    const w = await resourceWorld({ answers: [reply(200, { autoAdvance: 'keyboard' })] });
    await createPrefs(w.deps).patch({ autoAdvance: 'keyboard' });
    w.state.online = false;
    expect((await restart(w).load()).autoAdvance).toBe('keyboard');
  });

  it('read reports whether a change is waiting', async () => {
    const w = await resourceWorld({ online: false, answers: [reply(200, { autoAdvance: 'off' })] });
    const prefs = createPrefs(w.deps);
    expect((await prefs.read()).pending).toBe(false);
    await prefs.patch({ autoAdvance: 'off' });
    expect(await prefs.read()).toEqual({ prefs: { ...DEFAULT_INSPECTION_PREFS, autoAdvance: 'off' }, pending: true });
    w.state.online = true;
    await prefs.flush();
    expect((await prefs.read()).pending).toBe(false);
  });
});

describe('prefs persistence: clear local data', () => {
  it('removes the stored copy and the pending change (control: they were there)', async () => {
    const w = await resourceWorld({ online: false });
    await createPrefs(w.deps).patch({ autoAdvance: 'off' });
    expect(await stored(w.db)).not.toBeNull();
    await clearLocalData(w.db, createMemoryFiles(), 1);
    expect(await stored(w.db)).toBeNull();
    expect(await restart(w).load()).toEqual(DEFAULT_INSPECTION_PREFS);
  });
});
