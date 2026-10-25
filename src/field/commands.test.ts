import { beforeEach, describe, expect, it } from 'vitest';
import { createBlockedGuard } from '../offline/blocked';
import { enqueue, listOutbox } from '../offline/outbox';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createExecutor, type CommandDeps } from './commands';
import { createEditorLoader } from './editor-data';
import { MESSAGES, isNeedsConnection } from './messages';
import { ALL_COMMANDS, LOCAL_TYPES } from './test-support/all-commands';
import { reply, scriptedApi, type ScriptedApi } from './test-support/scripted-api';
import { ALICE, seedPackage } from './test-support/seed-package';

let db: Db;
let api: ScriptedApi;
let online: boolean;
const clock = createManualClock(1000);

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  const load = createEditorLoader({ db, account: ALICE, isBlocked: createBlockedGuard(db) });
  return {
    isBlocked: createBlockedGuard(db),
    isOnline: () => online,
    enqueue: (op, input) => enqueue({ db, clock }, op, input, { account: ALICE }),
    api,
    now: () => 5000,
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
  api = scriptedApi();
  online = false;
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
