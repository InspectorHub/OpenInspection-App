import { beforeEach, describe, expect, it } from 'vitest';
import { createBlockedGuard } from '../offline/blocked';
import { enqueue } from '../offline/outbox';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createExecutor, type CommandDeps } from './commands';
import { hasQueuedWrites } from './queued-writes';
import { reply, scriptedApi, type ScriptedApi } from './test-support/scripted-api';
import { ALICE, seedPackage } from './test-support/seed-package';

/** What a publish sends and what it makes of the answer: the republish notice choice and the "nothing changed" receipt. */
let db: Db;
let api: ScriptedApi;
const clock = createManualClock(1000);

function deps(): CommandDeps {
  return {
    isBlocked: createBlockedGuard(db),
    isOnline: () => true,
    enqueue: (op, input) => enqueue({ db, clock }, op, input, { account: ALICE }),
    api,
    signedAtMs: () => 5000,
    hasQueuedWrites: (id) => hasQueuedWrites(db, ALICE, id),
    unsentPhotos: () => Promise.resolve('none'),
    afterWrite: () => Promise.resolve(true),
    loadScope: () => Promise.resolve({}),
  };
}

const publishCall = () => api.calls.find((c) => c.path.endsWith('/publish'));

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  await seedPackage(db, 'i1');
});

describe('execute: publish request body', () => {
  it('sends notifyClient only when the inspector chose yes', async () => {
    api = scriptedApi();
    await createExecutor(deps())('i1', { type: 'publish', notifyClient: true });
    expect(publishCall()?.json).toEqual({ notifyClient: true });
  });

  it('sends nothing about notices when the choice is no or absent (the server then sends none)', async () => {
    api = scriptedApi();
    await createExecutor(deps())('i1', { type: 'publish', notifyClient: false });
    expect(publishCall()?.json).toEqual({});
    api = scriptedApi();
    await createExecutor(deps())('i1', { type: 'publish' });
    expect(publishCall()?.json).toEqual({});
  });

  it('keeps the summary beside the choice', async () => {
    api = scriptedApi();
    await createExecutor(deps())('i1', { type: 'publish', summary: ' Fixed the roof rating ', notifyClient: true });
    expect(publishCall()?.json).toEqual({ summary: 'Fixed the roof rating', notifyClient: true });
  });
});

describe('execute: publish answer', () => {
  it('a real publish answers ok with no version to report as unchanged', async () => {
    api = scriptedApi(reply(200, { success: true, data: { reportUrl: '/report/acme/i1', reportStatus: 'published', isnSync: null } }));
    expect(await createExecutor(deps())('i1', { type: 'publish' })).toEqual({ ok: true, data: { unchangedSinceVersion: null } });
  });

  it('a publish with nothing changed carries the version that is still current', async () => {
    api = scriptedApi(reply(200, { success: true, data: { reportUrl: '/report/acme/i1', reportStatus: 'published', isnSync: null, unchangedSinceVersion: 3 } }));
    expect(await createExecutor(deps())('i1', { type: 'publish' })).toEqual({ ok: true, data: { unchangedSinceVersion: 3 } });
  });

  it('a refusal because the report is published says so in the server sentence and is not ok', async () => {
    api = scriptedApi(reply(409, { success: false, error: { code: 'REPORT_PUBLISHED', message: 'This report is published. Choose Edit and republish first.' } }));
    const result = await createExecutor(deps())('i1', { type: 'publish' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Edit and republish');
  });
});
