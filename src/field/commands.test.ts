import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlockedGuard } from '../offline/blocked';
import { enqueue, listOutbox } from '../offline/outbox';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createExecutor, type CommandDeps } from './commands';
import { createAfterWrite } from './after-write';
import { createEditorLoader } from './editor-data';
import { hasQueuedWrites } from './queued-writes';
import { MESSAGES, isNeedsConnection } from './messages';
import { ALL_COMMANDS, LOCAL_TYPES } from './test-support/all-commands';
import { reply, scriptedApi, type ScriptedApi } from './test-support/scripted-api';
import { ALICE, envelope, seedPackage } from './test-support/seed-package';

let db: Db;
let api: ScriptedApi;
let online: boolean;
let afterWrite: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
let stale: string[];
const clock = createManualClock(1000);

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
  return {
    isBlocked: createBlockedGuard(db),
    isOnline: () => online,
    enqueue: (op, input) => enqueue({ db, clock }, op, input, { account: ALICE }),
    api,
    signedAtMs: () => 5000,
    hasQueuedWrites: (id) => hasQueuedWrites(db, ALICE, id),
    unsentPhotos: () => Promise.resolve('none'),
    afterWrite,
    onCacheStale: (id) => stale.push(id),
    loadScope: async (id, scope) => (await load(id, scope)).results,
    ...over,
  };
}

const run = (cmd: Parameters<ReturnType<typeof createExecutor>>[1], id = 'i1', opts?: { idempotencyKey?: string }) => createExecutor(deps())(id, cmd, opts);
const queuedRows = () => listOutbox(db, {});

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  await seedPackage(db, 'i1');
  await seedPackage(db, 'i2', { skipGlobals: true });
  api = scriptedApi();
  online = false;
  afterWrite = vi.fn((_id: string) => Promise.resolve(true));
  stale = [];
});

describe('execute: offline', () => {
  const remote = ALL_COMMANDS.filter((cmd) => !LOCAL_TYPES.includes(cmd.type));

  it.each(remote.map((cmd) => [cmd.type + ('op' in cmd ? `:${cmd.op}` : ''), cmd] as const))('%s needs a connection, sends nothing and queues nothing', async (_name, cmd) => {
    const result = await run(cmd);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MESSAGES.needsConnection);
    expect(result.error).not.toBe('needs_connection');
    expect(isNeedsConnection(result)).toBe(true);
    expect(api.calls).toHaveLength(0);
    expect(await queuedRows()).toHaveLength(0);
  });

  it('autofill answers with no facts and the request-failed reason the panel reads', async () => {
    const result = await run({ type: 'autofill-property-facts', addressString: '12 Test Street' });
    expect(result.data).toEqual({ facts: null, reason: 'REQUEST_FAILED' });
  });

  it('control: the same commands are sent once the device is online', async () => {
    online = true;
    for (const cmd of remote) await run(cmd);
    expect(api.calls.length).toBeGreaterThanOrEqual(remote.length);
  });
});

describe('execute: complete', () => {
  it('queues inspection.complete for this inspection, offline or online, and sends nothing', async () => {
    for (const state of [false, true]) {
      online = state;
      expect((await run({ type: 'complete' })).ok).toBe(true);
    }
    const rows = await queuedRows();
    expect(rows.map((row) => row.op)).toEqual(['inspection.complete', 'inspection.complete']);
    expect(rows.every((row) => row.inspectionId === 'i1')).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('queues the complete for the inspection it was given, not for another', async () => {
    await run({ type: 'complete' }, 'i2');
    const rows = await queuedRows();
    expect(rows.map((row) => row.inspectionId)).toEqual(['i2']);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({ inspectionId: 'i2' });
    const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
    expect((await load('i2')).inspection.status).toBe('completed');
    expect((await load('i1')).inspection.status).toBe('draft');
  });

  it('a reload right after complete does not revert it; without the complete the status is the cached one', async () => {
    const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
    expect((await load('i1')).inspection.status).toBe('draft');
    await run({ type: 'complete' });
    expect((await load('i1')).inspection.status).toBe('completed');
  });
});

describe('execute: save-settings', () => {
  it('offline, a change within the registry fields is queued as inspection.update', async () => {
    const result = await run({ type: 'save-settings', payload: { propertyType: 'multi_unit', propertyAddress: '' } });
    expect(result.ok).toBe(true);
    const rows = await queuedRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({ inspectionId: 'i1', changes: { propertyType: 'multi_unit' } });
    expect(api.calls).toHaveLength(0);
  });

  it('offline, a key outside the registry fields needs a connection and nothing is queued', async () => {
    const result = await run({ type: 'save-settings', payload: { templateId: 'tpl-2' } });
    expect(isNeedsConnection(result)).toBe(true);
    expect(await queuedRows()).toHaveLength(0);
  });

  it('offline, a change that mixes allowed and other keys is not queued as the smaller change', async () => {
    const result = await run({ type: 'save-settings', payload: { propertyType: 'multi_unit', templateId: 'tpl-2' } });
    expect(isNeedsConnection(result)).toBe(true);
    expect(await queuedRows()).toHaveLength(0);
  });

  it('offline, empty strings are dropped before the key check', async () => {
    const result = await run({ type: 'save-settings', payload: { propertyType: 'multi_unit', templateId: '' } });
    expect(result.ok).toBe(true);
    expect(await queuedRows()).toHaveLength(1);
  });

  it('offline, a value the registry refuses is told as such and nothing is queued', async () => {
    const result = await run({ type: 'save-settings', payload: { propertyAddress: 'abc' } });
    expect(result).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await queuedRows()).toHaveLength(0);
  });

  it('a change with nothing in it is a no-op that answers ok', async () => {
    expect((await run({ type: 'save-settings', payload: { propertyAddress: '' } })).ok).toBe(true);
    expect(await queuedRows()).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it('online, the whole sanitised change is sent, template included, and nothing is queued', async () => {
    online = true;
    const result = await run({ type: 'save-settings', payload: { templateId: 'tpl-2', propertyType: 'multi_unit', price: '350' } });
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', path: '/api/inspections/i1', json: { templateId: 'tpl-2', propertyType: 'multi_unit', price: 350 } });
    expect(await queuedRows()).toHaveLength(0);
  });
});

describe('execute: blocked and invalid inspections', () => {
  it('a blocked inspection is refused for every command, online, with no request and no queued write', async () => {
    online = true;
    await db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['i1']);
    for (const cmd of ALL_COMMANDS) {
      const result = await run(cmd);
      expect(result).toEqual({ ok: false, error: MESSAGES.blocked });
    }
    expect(api.calls).toHaveLength(0);
    expect(await queuedRows()).toHaveLength(0);
  });

  it('a quarantined inspection is refused the same way', async () => {
    await db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = ?", ['i1']);
    expect(await run({ type: 'complete' })).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(await queuedRows()).toHaveLength(0);
  });

  it('control: the same command goes through when nothing blocks it', async () => {
    expect((await run({ type: 'complete' })).ok).toBe(true);
    expect(await queuedRows()).toHaveLength(1);
  });

  it('an id that is not an inspection id is refused without touching anything', async () => {
    online = true;
    for (const id of ['../x', 'bulk', '']) {
      expect(await run({ type: 'publish' }, id)).toEqual({ ok: false, error: MESSAGES.unavailable });
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe('execute: load-scope and the pass-through of the idempotency key', () => {
  it('answers a scope from the downloaded results, in the shape the editor merges', async () => {
    const result = await run({ type: 'load-scope', scope: 'unit-1' });
    expect(result).toEqual({ ok: true, data: { scope: 'unit-1', results: { 'unit-1:sec_roof:itm_cover': { rating: 'poor' } } } });
    expect(api.calls).toHaveLength(0);
  });

  it('control: another scope is another slice', async () => {
    const result = await run({ type: 'load-scope', scope: 'unit-9' });
    expect(result).toEqual({ ok: true, data: { scope: 'unit-9', results: {} } });
  });

  it('a scope that cannot be read answers the loader sentence', async () => {
    const result = await run({ type: 'load-scope', scope: 'unit-1' }, 'nope');
    expect(result).toEqual({ ok: false, error: MESSAGES.unavailable });
  });

  it('the key given to execute reaches the request of a creating command, and only that one', async () => {
    online = true;
    api = scriptedApi(reply(200, {}), reply(200, {}));
    await run({ type: 'unit', op: 'create', name: 'A' }, 'i1', { idempotencyKey: 'key-9' });
    await run({ type: 'unit', op: 'rename', unitId: 'u1', name: 'B' }, 'i1', { idempotencyKey: 'key-9' });
    expect(api.calls[0]?.idempotencyKey).toBe('key-9');
    expect(api.calls[1]?.idempotencyKey).toBeUndefined();
  });
});

describe('execute: save-settings and writes that are still queued', () => {
  const queueAnUpdate = (id = 'i1') => enqueue({ db, clock }, 'inspection.update', { inspectionId: id, changes: { sqft: 900 } }, { account: ALICE });

  it('online with an earlier write still queued, a change within the registry fields is queued behind it, not sent past it', async () => {
    online = true;
    await queueAnUpdate();
    const result = await run({ type: 'save-settings', payload: { sqft: 1500 } });
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(0);
    expect((await queuedRows()).map((row) => (JSON.parse(row.payload) as { changes: unknown }).changes)).toEqual([{ sqft: 900 }, { sqft: 1500 }]);
  });

  it('online with an earlier write still queued, a change outside the registry fields is not sent and asks to try again', async () => {
    online = true;
    await queueAnUpdate();
    const result = await run({ type: 'save-settings', payload: { templateId: 'tpl-2' } });
    expect(result).toEqual({ ok: false, error: MESSAGES.pendingChanges });
    expect(api.calls).toHaveLength(0);
    expect(await queuedRows()).toHaveLength(1);
  });

  it('a failed earlier write holds the line too', async () => {
    online = true;
    const row = await queueAnUpdate();
    await db.run("UPDATE outbox SET state = 'failed', last_error = 'rejected' WHERE idempotency_key = ?", [row.idempotencyKey]);
    expect(await run({ type: 'save-settings', payload: { templateId: 'tpl-2' } })).toEqual({ ok: false, error: MESSAGES.pendingChanges });
    expect(api.calls).toHaveLength(0);
  });

  it('any op holds the line: a queued complete is enough', async () => {
    online = true;
    await run({ type: 'complete' });
    expect(await run({ type: 'save-settings', payload: { templateId: 'tpl-2' } })).toEqual({ ok: false, error: MESSAGES.pendingChanges });
  });

  it('control: with nothing queued the change goes online as before, template included', async () => {
    online = true;
    const result = await run({ type: 'save-settings', payload: { templateId: 'tpl-2', sqft: 1500 } });
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(await queuedRows()).toHaveLength(0);
  });

  it('control: the queued write of another inspection does not hold this one', async () => {
    online = true;
    await queueAnUpdate('i2');
    const result = await run({ type: 'save-settings', payload: { templateId: 'tpl-2' } });
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(1);
  });

  it('offline the line does not matter: eligible is queued, the rest needs a connection', async () => {
    await queueAnUpdate();
    expect((await run({ type: 'save-settings', payload: { sqft: 1500 } })).ok).toBe(true);
    expect(isNeedsConnection(await run({ type: 'save-settings', payload: { templateId: 'x' } }))).toBe(true);
  });
});

describe('execute: the hostile and the invalid in a settings change', () => {
  it('an own __proto__ key cannot lend the queued change a value the key check never saw', async () => {
    const payload = JSON.parse('{"__proto__":{"yearBuilt":1999},"propertyType":"multi_unit"}') as Record<string, unknown>;
    const result = await run({ type: 'save-settings', payload });
    expect(result.ok).toBe(true);
    const rows = await queuedRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({ inspectionId: 'i1', changes: { propertyType: 'multi_unit' } });
  });

  it('control: the same patch without the hostile key is queued as it is', async () => {
    await run({ type: 'save-settings', payload: { propertyType: 'multi_unit' } });
    expect((JSON.parse((await queuedRows())[0]?.payload ?? '{}') as { changes: unknown }).changes).toEqual({ propertyType: 'multi_unit' });
  });

  it('a hostile key alone is a no-op, and online it is not sent', async () => {
    online = true;
    const payload = JSON.parse('{"__proto__":{"templateId":"x"}}') as Record<string, unknown>;
    expect((await run({ type: 'save-settings', payload })).ok).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('an impossible date offline is an invalid value, not an unavailable inspection', async () => {
    const result = await run({ type: 'save-settings', payload: { date: '2026-13-45' } });
    expect(result).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await queuedRows()).toHaveLength(0);
  });

  it('control: a real date is queued as a date-time', async () => {
    expect((await run({ type: 'save-settings', payload: { date: '2026-05-01' } })).ok).toBe(true);
    expect(await queuedRows()).toHaveLength(1);
  });
});

describe('execute: the cache after a successful online write', () => {
  const WRITES = ALL_COMMANDS.filter((cmd) => !LOCAL_TYPES.includes(cmd.type) && cmd.type !== 'autofill-property-facts');

  it('refreshes that inspection once after every online write that succeeded', async () => {
    online = true;
    let succeeded = 0;
    for (const cmd of WRITES) {
      afterWrite.mockClear();
      api = scriptedApi(reply(200, { data: { key: 'k', name: 'N' } }), reply(200, { data: { key: 'k', name: 'N' } }));
      const result = await run(cmd);
      if (result.ok) {
        succeeded += 1;
        expect(afterWrite, cmd.type).toHaveBeenCalledExactlyOnceWith('i1');
      }
    }
    expect(succeeded).toBeGreaterThan(20);
  });

  it('save-settings online is refreshed too', async () => {
    online = true;
    await run({ type: 'save-settings', payload: { sqft: 1 } });
    expect(afterWrite).toHaveBeenCalledExactlyOnceWith('i1');
  });

  it('does not refresh after a write that failed, a read, or a write that was only queued', async () => {
    online = true;
    api = scriptedApi(reply(500));
    expect((await run({ type: 'set-cover', coverPhotoId: 'k' })).ok).toBe(false);
    api = scriptedApi(reply(200, { data: { facts: null, reason: null } }));
    await run({ type: 'autofill-property-facts', addressString: '12 Test Street' });
    await run({ type: 'load-scope', scope: 'unit-1' });
    await run({ type: 'complete' });
    online = false;
    await run({ type: 'save-settings', payload: { sqft: 1 } });
    await run({ type: 'set-cover', coverPhotoId: 'k' });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('a refresh that could not be done leaves the command ok and reports the stale cache', async () => {
    online = true;
    afterWrite.mockResolvedValue(false);
    const result = await run({ type: 'set-cover', coverPhotoId: 'k' });
    expect(result).toEqual({ ok: true });
    expect(stale).toEqual(['i1']);
  });

  it('control: a refresh that worked reports nothing', async () => {
    online = true;
    await run({ type: 'set-cover', coverPhotoId: 'k' });
    expect(stale).toEqual([]);
  });

  it('a refresh that throws is the same: the write succeeded', async () => {
    online = true;
    afterWrite.mockRejectedValue(new Error('x'));
    expect(await run({ type: 'set-cover', coverPhotoId: 'k' })).toEqual({ ok: true });
    expect(stale).toEqual(['i1']);
  });

  const timers = { setTimeout: (cb: () => void, ms: number): unknown => setTimeout(cb, ms), clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>) };

  it('a reload after the write shows the new value', async () => {
    online = true;
    const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
    const serverNow = async (): Promise<{ kind: 'refreshed' }> => {
      await db.run('UPDATE resource_cache SET body = ? WHERE key = ?', [envelope({ inspection: { id: 'i1', status: 'draft', propertyType: 'multi_unit' } }), '/api/inspections/i1']);
      return { kind: 'refreshed' };
    };
    const working = createAfterWrite({ refresher: { refreshInspection: serverNow }, settle: () => Promise.resolve(), timers, timeoutMs: 8000 });
    expect((await load('i1')).inspection.propertyType).toBe('single_family');
    const done = await createExecutor(deps({ afterWrite: working }))('i1', { type: 'save-settings', payload: { propertyType: 'multi_unit' } });
    expect(done.ok).toBe(true);
    expect((await load('i1')).inspection.propertyType).toBe('multi_unit');
  });

  it('control: when the refresh fails the old value stays, the command is ok, and the stale cache is reported', async () => {
    online = true;
    const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
    const failing = createAfterWrite({ refresher: { refreshInspection: () => Promise.resolve({ kind: 'failed' as const }) }, settle: () => Promise.resolve(), timers, timeoutMs: 8000 });
    const done = await createExecutor(deps({ afterWrite: failing }))('i1', { type: 'save-settings', payload: { propertyType: 'multi_unit' } });
    expect(done.ok).toBe(true);
    expect((await load('i1')).inspection.propertyType).toBe('single_family');
    expect(stale).toEqual(['i1']);
  });
});
