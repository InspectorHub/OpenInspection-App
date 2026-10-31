import { beforeEach, describe, expect, it } from 'vitest';
import { CollabBlockedError } from '../collab/connector';
import type { Db } from '../platform/db';
import { isNotFoundError } from '../platform/files-path';
import { enqueue, OutboxError, accountKey } from './outbox';
import { purgeAuthorityForTest } from './test-support/brands';
import { purgeInspection, resumePurges, type PurgeDeps, type PurgeOutcome } from './purge';
import { fingerprintOf } from './reconcile-decision';
import { replaceInspectionResources } from './resource-cache';
import { failingDb } from './test-support/failing-db';
import { createPurgeWorld, type InspectionTable, type PurgeWorld } from './test-support/purge-world';
import { ALICE, BOB } from './test-support/reconcile-world';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

const ZERO: Record<InspectionTable | 'files', number> = { work_package: 0, outbox: 0, media: 0, ydoc_updates: 0, ydoc_sync: 0, resource_cache: 0, item_tags: 0, files: 0 };

async function auto(id: string, deps: PurgeDeps = world.purgeDeps(), fingerprint?: string): Promise<PurgeOutcome> {
  return purgeInspection(deps, id, { mode: 'auto', account: ALICE, expectedFingerprint: fingerprint ?? (await fingerprintOf(world.db, id)) });
}
/**
 * A person-confirmed purge. The tests in this file are about the steps of the purge, not about which inspections may be
 * removed (`purge-hardening.test.ts` covers that), so a healthy inspection is quarantined first, as it would be in use.
 */
const confirmed = async (id: string, deps: PurgeDeps = world.purgeDeps()): Promise<PurgeOutcome> => {
  await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = ? AND purging = 0 AND quarantine_source IS NULL", [id]);
  return purgeInspection(deps, id, { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() });
};
const resume = (id: string, deps: PurgeDeps = world.purgeDeps()): Promise<PurgeOutcome> => purgeInspection(deps, id, { mode: 'resume', account: ALICE, authority: purgeAuthorityForTest() });

const purgingOf = async (id: string): Promise<number | null> => {
  const rows = await world.db.query<{ purging: number }>('SELECT purging FROM work_package WHERE inspection_id = ?', [id]);
  return rows[0] === undefined ? null : Number(rows[0].purging);
};

/** A database whose statements are reported to `log` before they run, inside transactions as well. */
function logging(inner: Db, log: (sql: string, params?: unknown[]) => void): Db {
  const wrap = (db: Db): Db => ({
    execute: (sql) => db.execute(sql),
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => {
      log(sql, params);
      return db.run(sql, params);
    },
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

/** Three inspections: the middle one is the target, the other two hold data in every table and must never change. */
async function threeWithTarget(kind: 'purgeable' | 'full'): Promise<{ before: Record<string, string> }> {
  await world.seedFull('p1');
  if (kind === 'purgeable') await world.seedPurgeable('p2');
  else await world.seedFull('p2');
  await world.seedFull('p3', { quarantine: 'reconcile_missing' });
  await world.db.run("INSERT INTO device_state (key, value) VALUES ('seed-a', '1')");
  await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '/api/inspections/p2', 'e', 'bob-copy', 5, 'p2')", [accountKey(BOB)]);
  await world.db.run("INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, '/api/tags', 'e', '{}', 5, '$global')", [accountKey(ALICE)]);
  return { before: { p1: await world.data('p1'), p3: await world.data('p3') } };
}

async function othersUnchanged(before: Record<string, string>): Promise<void> {
  expect(await world.data('p1')).toBe(before.p1);
  expect(await world.data('p3')).toBe(before.p3);
}

describe('an automatic purge of one inspection', () => {
  it('removes every trace of the target and leaves the other two inspections byte for byte as they were', async () => {
    const { before } = await threeWithTarget('purgeable');
    expect((await world.counts('p2')).ydoc_updates).toBeGreaterThan(0);
    const deviceBefore = await world.db.query('SELECT * FROM device_state ORDER BY key');
    const outcome = await auto('p2');
    expect(outcome).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    await othersUnchanged(before);
    expect(await world.db.query('SELECT * FROM device_state ORDER BY key')).toEqual(deviceBefore);
    // Another account's copy of the same package id, and the account's global reads, are not the target's.
    expect(await world.db.query('SELECT body FROM resource_cache WHERE package_id = ?', ['p2'])).toEqual([{ body: 'bob-copy' }]);
    expect(await world.db.query("SELECT key FROM resource_cache WHERE package_id = '$global'")).toEqual([{ key: '/api/tags' }]);
    expect(world.purgingSignals).toEqual(['p2']);
  });

  it('control: the same call changes nothing for an inspection that does not exist', async () => {
    await threeWithTarget('purgeable');
    const hash = await world.hash();
    expect(await auto('p9', world.purgeDeps(), 'x')).toEqual({ kind: 'refused', reason: 'no_package' });
    expect(await world.hash()).toBe(hash);
  });

  it('runs the steps in the one order that is safe: tombstone, editor signal, connector, uploads, files, media rows, cache, outbox check, package row', async () => {
    await world.seedPurgeable('p2');
    const order: string[] = [];
    const db = logging(world.db, (sql, params) => {
      if (/UPDATE work_package SET purging/.test(sql)) order.push(`tombstone=${String(params?.[0])}`);
      if (/DELETE FROM resource_cache/.test(sql)) order.push('cache');
      if (/DELETE FROM work_package/.test(sql)) order.push('package');
    });
    const deps = world.purgeDeps({
      db,
      onPurging: async (id) => {
        order.push(`signal:${String(await purgingOf(id))}`);
      },
      connector: {
        closeFor: (id) => world.connector.closeFor(id),
        purge: async (id) => {
          order.push('connector');
          await world.connector.purge(id);
        },
      },
      uploader: {
        cancelFor: () => {
          order.push('cancel');
          return Promise.resolve();
        },
      },
    });
    expect(await auto('p2', deps)).toEqual({ kind: 'purged' });
    expect(order).toEqual(['tombstone=1', 'signal:1', 'connector', 'cancel', 'cache', 'cache', 'package']);
  });

  it('files are removed one by one before their rows, and all of them before the cache', async () => {
    await world.seedFull('p2', { unsent: true });
    const events: string[] = [];
    const files = world.files;
    const remove = files.remove.bind(files);
    files.remove = (path) => {
      events.push(`file:${path}`);
      return remove(path);
    };
    const db = logging(world.db, (sql, params) => {
      if (/DELETE FROM media/.test(sql)) events.push(`row:${String(params?.[0])}`);
      if (/DELETE FROM resource_cache/.test(sql)) events.push('cache');
    });
    expect(await confirmed('p2', world.purgeDeps({ db }))).toEqual({ kind: 'purged' });
    expect(events.slice(0, 5)).toEqual(['file:media/p2-m1.jpg', 'row:p2-m1', 'file:media/p2-m2.jpg', 'row:p2-m2', 'cache']);
  });
});

describe('what an automatic purge refuses, each with the same state minus the reason as a control', () => {
  it.each([
    ['a queued write that appeared after the plan', async () => world.outbox('p2', 'pending')],
    ['a photo row that appeared after the plan', async () => world.mediaFile('p2', 'late', 'pending')],
    ['an edit nobody sent', async () => void (await world.ydoc('p2'))],
  ])('%s: the fingerprint no longer matches, so nothing is written', async (_name, change) => {
    await world.seedPurgeable('p2');
    const planned = await fingerprintOf(world.db, 'p2');
    await change();
    const hash = await world.hash();
    expect(await auto('p2', world.purgeDeps(), planned)).toEqual({ kind: 'refused', reason: 'changed' });
    expect(await world.hash()).toBe(hash);
    expect(world.purgingSignals).toEqual([]);
  });

  it.each([
    ['a queued write', async () => world.outbox('p2', 'pending'), 'outbox_pending'],
    ['a failed queued write', async () => world.outbox('p2', 'failed'), 'outbox_failed'],
    ['an orphaned queued write', async () => world.outbox('p2', 'orphaned'), 'outbox_orphaned'],
    ['a photo waiting', async () => void (await world.mediaFile('p2', 'm', 'pending')), 'media_not_uploaded'],
    ['an uploaded photo nothing placed', async () => void (await world.mediaFile('p2', 'm', 'uploaded')), 'media_uploaded_unresolved'],
    ['edits the server may not have', async () => void (await world.ydoc('p2')), 'ydoc_not_on_server'],
    // Not in the fingerprint (tags are rows with a state, not part of the queue), so only this predicate stands between
    // an automatic purge and a tag change nobody sent.
    ['a tag added and not yet sent', async () => void (await world.db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, 'p2', 'item-9', 'tag-9', 'Late', NULL, 'add', 9)", [accountKey(ALICE)])), 'tags_not_on_server'],
    ['a tag removed and not yet sent', async () => void (await world.db.run("UPDATE item_tags SET state = 'remove' WHERE inspection_id = 'p2'")), 'tags_not_on_server'],
  ])('%s that the fingerprint already includes: the unsent predicate stops it inside the tombstone transaction', async (_name, change, reason) => {
    await world.seedPurgeable('p2');
    await change();
    const hash = await world.hash();
    const outcome = await auto('p2');
    expect(outcome).toMatchObject({ kind: 'unsent_now' });
    expect(outcome.kind === 'unsent_now' && outcome.reasons).toContain(reason);
    expect(await world.hash()).toBe(hash);
    expect(await purgingOf('p2')).toBe(0);
    expect(world.purgingSignals).toEqual([]);
  });

  it('control: the same inspection with none of those is purged', async () => {
    await world.seedPurgeable('p2');
    expect(await auto('p2')).toEqual({ kind: 'purged' });
  });

  it.each([
    ['belongs to another account', () => world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'"), 'not_owner'],
    ['belongs to nobody', () => world.db.run('UPDATE work_package SET tenant_id = NULL, user_id = NULL WHERE inspection_id = ?', ['p2']), 'not_owner'],
    ['was never acknowledged by the server', () => world.db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = ?', ['p2']), 'unconfirmed'],
    ['is quarantined', () => world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'"), 'quarantined'],
    ['is already tombstoned', () => world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']), 'tombstoned'],
    ['still has its create queued', () => world.outbox('p2', 'pending', { op: 'inspection.create' }), 'create_pending'],
  ])('refuses a package that %s', async (_name, change, reason) => {
    await world.seedPurgeable('p2');
    await change();
    const planned = await fingerprintOf(world.db, 'p2');
    const hash = await world.hash();
    expect(await auto('p2', world.purgeDeps(), planned)).toEqual({ kind: 'refused', reason });
    expect(await world.hash()).toBe(hash);
  });

  it('refuses the whole run while a queued write names no inspection', async () => {
    await world.seedPurgeable('p2');
    await world.outbox(null, 'pending');
    const planned = await fingerprintOf(world.db, 'p2');
    expect(await auto('p2', world.purgeDeps(), planned)).toEqual({ kind: 'refused', reason: 'unattributable' });
    expect(await purgingOf('p2')).toBe(0);
  });

  it('refuses an id that could not be an inspection id', async () => {
    expect(await auto('../etc', world.purgeDeps(), 'x')).toEqual({ kind: 'refused', reason: 'invalid_id' });
  });

  it('refuses an account that is not usable', async () => {
    await world.seedPurgeable('p2');
    const outcome = await purgeInspection(world.purgeDeps(), 'p2', { mode: 'auto', account: { tenantId: '', userId: '' }, expectedFingerprint: await fingerprintOf(world.db, 'p2') });
    expect(outcome).toEqual({ kind: 'refused', reason: 'not_owner' });
  });

  it('fails closed when the guard the other modules use does not report the tombstone: the tombstone stays, nothing else is touched', async () => {
    await world.seedPurgeable('p2');
    const outcome = await auto('p2', world.purgeDeps({ isBlocked: () => Promise.resolve(false) }));
    expect(outcome).toEqual({ kind: 'failed', step: 'tombstone', code: 'guard_not_effective' });
    expect(await purgingOf('p2')).toBe(1);
    expect((await world.counts('p2')).ydoc_updates).toBeGreaterThan(0);
    expect(world.purgingSignals).toEqual([]);
  });
});

describe('a purge and an editor that has the inspection open', () => {
  it('automatic: deferred before anything is written, and the editor is not signalled', async () => {
    await world.seedPurgeable('p2');
    world.editorOpen.add('p2');
    const hash = await world.hash();
    expect(await auto('p2')).toEqual({ kind: 'deferred', reason: 'open_in_editor' });
    expect(await world.hash()).toBe(hash);
    expect(world.purgingSignals).toEqual([]);
  });

  it('control: the same inspection with the editor closed is purged', async () => {
    await world.seedPurgeable('p2');
    expect(await auto('p2')).toEqual({ kind: 'purged' });
  });

  it('automatic: an editor port that cannot answer counts as open', async () => {
    await world.seedPurgeable('p2');
    const outcome = await auto('p2', world.purgeDeps({ isOpenInEditor: () => Promise.reject(new Error('no answer')) }));
    expect(outcome).toEqual({ kind: 'deferred', reason: 'open_in_editor' });
    expect(await purgingOf('p2')).toBe(0);
  });

  it('user confirmed: the editor is signalled, its live connection is closed, and the data goes', async () => {
    await world.seedFull('p2');
    await world.seedFull('p1');
    world.editorOpen.add('p2');
    const open = world.connect('p2');
    const other = world.connect('p1');
    await open.persistenceSynced;
    await other.persistenceSynced;
    await new Promise((resolve) => setImmediate(resolve));
    expect(world.connector.isOpen('p2')).toBe(true);
    const keep = await world.data('p1');
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(world.purgingSignals).toEqual(['p2']);
    expect(world.connector.isOpen('p2')).toBe(false);
    expect(world.connector.isOpen('p1')).toBe(true);
    expect(await world.counts('p2')).toEqual(ZERO);
    expect(await world.data('p1')).toBe(keep);
    other.destroy();
  });

  it('a connection attempt after the tombstone is refused with the typed error', async () => {
    await world.seedPurgeable('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    await expect(world.connect('p2').persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
  });
});

describe('a purge and the transfers in flight', () => {
  it('asks the uploader to cancel the inspection before any file is removed', async () => {
    await world.seedFull('p2');
    const order: string[] = [];
    const remove = world.files.remove.bind(world.files);
    world.files.remove = (path) => {
      order.push('remove');
      return remove(path);
    };
    const deps = world.purgeDeps({
      uploader: {
        cancelFor: (id) => {
          order.push(`cancel:${id}`);
          return Promise.resolve();
        },
      },
    });
    await confirmed('p2', deps);
    expect(order).toEqual(['cancel:p2', 'remove', 'remove']);
  });

  it('an uploader that cannot cancel (or throws) does not stop the purge', async () => {
    await world.seedFull('p2');
    const throwing = world.purgeDeps({ uploader: { cancelFor: () => Promise.reject(new Error('plugin gone')) } });
    expect(await confirmed('p2', throwing)).toEqual({ kind: 'purged' });
    await world.seedFull('p4');
    const absent = world.purgeDeps();
    delete (absent as { uploader?: unknown }).uploader;
    expect(await confirmed('p4', absent)).toEqual({ kind: 'purged' });
  });
});

describe('the files of a purge', () => {
  it('a file that is already gone counts as removed', async () => {
    await world.seedFull('p2');
    await world.files.remove('media/p2-m1.jpg');
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect((await world.counts('p2')).media).toBe(0);
  });

  it('a removal that fails while the file is still there stops the purge before any media row of that file is deleted, and keeps the tombstone', async () => {
    await world.seedFull('p2');
    world.files.failRemoveFor('media/p2-m1.jpg');
    const outcome = await confirmed('p2');
    expect(outcome).toEqual({ kind: 'failed', step: 'files', code: 'file_remove_failed' });
    expect(await purgingOf('p2')).toBe(2);
    const rows = await world.db.query<{ pending_id: string }>('SELECT pending_id FROM media WHERE inspection_id = ? ORDER BY pending_id', ['p2']);
    expect(rows).toEqual([{ pending_id: 'p2-m1' }]);
    expect(world.files.paths()).toContain('media/p2-m1.jpg');
    expect((await world.counts('p2')).work_package).toBe(1);
    expect((await world.counts('p2')).resource_cache).toBeGreaterThan(0);
  });

  it('a removal error for a file that is gone afterwards counts as removed', async () => {
    await world.seedFull('p2');
    const remove = world.files.remove.bind(world.files);
    world.files.remove = async (path) => {
      await remove(path);
      throw new Error('late plugin error');
    };
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
  });

  it('an existence check that cannot answer is a failure, never "gone"', async () => {
    await world.seedFull('p2');
    world.files.failRemoveFor('media/p2-m1.jpg');
    world.files.failExistsFor('media/p2-m1.jpg');
    expect(await confirmed('p2')).toEqual({ kind: 'failed', step: 'files', code: 'file_remove_failed' });
  });

  it("a media row whose path is not its own file name never makes the purge touch that file; the row goes", async () => {
    await world.seedFull('p1');
    await world.seedFull('p2');
    await world.db.run("UPDATE media SET path = 'media/p1-m1.jpg' WHERE pending_id = 'p2-m1'");
    const bytes = world.files.bytes('media/p1-m1.jpg');
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(world.files.bytes('media/p1-m1.jpg')).toEqual(bytes);
    expect((await world.counts('p1')).files).toBe(2);
  });

  it('control: the same rows with their own paths remove exactly their own files', async () => {
    await world.seedFull('p1');
    await world.seedFull('p2');
    await confirmed('p2');
    expect(world.files.paths().sort()).toEqual(['media/p1-m1.jpg', 'media/p1-m2.jpg']);
  });

  it('a photo stored while the purge runs is removed too, in a later pass', async () => {
    await world.seedFull('p2');
    let injected = false;
    const remove = world.files.remove.bind(world.files);
    world.files.remove = async (path) => {
      await remove(path);
      if (!injected) {
        injected = true;
        await world.mediaFile('p2', 'late-one', 'pending');
      }
    };
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect(world.files.paths()).toEqual([]);
  });

  it('a stream of new photos that never ends is not followed forever: the purge reports it and keeps the tombstone', async () => {
    await world.seedFull('p2');
    let n = 0;
    const remove = world.files.remove.bind(world.files);
    world.files.remove = async (path) => {
      await remove(path);
      n += 1;
      await world.mediaFile('p2', `churn-${String(n)}`, 'pending');
    };
    const outcome = await confirmed('p2');
    expect(outcome).toEqual({ kind: 'failed', step: 'media_rows', code: 'media_churn' });
    expect(await purgingOf('p2')).toBe(2);
  });
});

describe('the tombstone', () => {
  it('automatic purges set 1 and user-confirmed ones 2', async () => {
    await world.seedPurgeable('p2');
    await world.seedFull('p3');
    const seen: Record<string, number | null> = {};
    await auto('p2', world.purgeDeps({ onPurging: async (id) => void (seen[id] = await purgingOf(id)) }));
    await confirmed('p3', world.purgeDeps({ onPurging: async (id) => void (seen[id] = await purgingOf(id)) }));
    expect(seen).toEqual({ p2: 1, p3: 2 });
  });

  it('every module refuses a tombstoned inspection: connect, queue, package refresh, new photo', async () => {
    await world.seedPurgeable('p2');
    const failed = await auto('p2', world.purgeDeps({ connector: { closeFor: (id) => world.connector.closeFor(id), purge: () => Promise.reject(new Error('injected')) } }));
    expect(failed).toMatchObject({ kind: 'failed', step: 'connector' });
    await expect(world.connect('p2').persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
    const error = await enqueue({ db: world.db, clock: world.clock }, 'inspection.update', { inspectionId: 'p2', changes: { sqft: 1 } }, { account: ALICE }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxError);
    expect(error).toMatchObject({ code: 'blocked' });
    const before = await world.counts('p2');
    expect(await replaceInspectionResources(world.db, { accountKey: accountKey(ALICE), inspectionId: 'p2', packageGen: 0, resources: new Map([['/api/inspections/p2', { body: '{}', fetchedAt: 9 }]]), refreshedAt: 9 })).toBe('purging');
    expect(await world.counts('p2')).toEqual(before);
  });

  it('a quarantined package is not refreshed either, while the same package without the quarantine is', async () => {
    await world.seedPurgeable('p2');
    const input = { accountKey: accountKey(ALICE), inspectionId: 'p2', packageGen: 0, resources: new Map([['/api/inspections/p2', { body: '{}', fetchedAt: 9 }]]), refreshedAt: 9 };
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'");
    expect(await replaceInspectionResources(world.db, input)).toBe('not_refreshable');
    await world.db.run('UPDATE work_package SET quarantine_source = NULL WHERE inspection_id = ?', ['p2']);
    expect(await replaceInspectionResources(world.db, input)).toBe('replaced');
  });

  it('control: the same calls on an inspection that is not tombstoned are accepted', async () => {
    await world.seedPurgeable('p2');
    const row = await enqueue({ db: world.db, clock: world.clock }, 'inspection.update', { inspectionId: 'p2', changes: { sqft: 1 } }, { account: ALICE });
    expect(row.inspectionId).toBe('p2');
    expect(await replaceInspectionResources(world.db, { accountKey: accountKey(ALICE), inspectionId: 'p2', packageGen: 0, resources: new Map([['/api/inspections/p2', { body: '{}', fetchedAt: 9 }]]), refreshedAt: 9 })).toBe('replaced');
  });
});

describe('the user-confirmed purge', () => {
  it('removes the queued writes and media of the inspection, and nothing of the others', async () => {
    const { before } = await threeWithTarget('full');
    expect((await world.counts('p2')).outbox).toBe(2);
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    await othersUnchanged(before);
  });

  it('control: an automatic purge of the same full inspection is refused as unsent', async () => {
    await world.seedFull('p2');
    expect(await auto('p2')).toMatchObject({ kind: 'unsent_now' });
    expect((await world.counts('p2')).outbox).toBe(2);
  });

  it('takes over a stuck automatic tombstone', async () => {
    await world.seedFull('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
  });

  it('still refuses a package of another account, and one the server never acknowledged while its create is queued', async () => {
    await world.seedFull('p2');
    await world.db.run("UPDATE work_package SET user_id = 'bob' WHERE inspection_id = 'p2'");
    expect(await confirmed('p2')).toEqual({ kind: 'refused', reason: 'not_owner' });
    await world.db.run("UPDATE work_package SET user_id = 'alice', server_confirmed = 0 WHERE inspection_id = 'p2'");
    await world.outbox('p2', 'failed', { op: 'inspection.create' });
    expect(await confirmed('p2')).toEqual({ kind: 'refused', reason: 'create_pending' });
    expect((await world.counts('p2')).outbox).toBe(3);
  });

  it('a package that was never sent (not acknowledged, no create queued) is removed on the owner confirming it, quarantined or not', async () => {
    await world.seedFull('p2');
    await world.db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = ?', ['p2']);
    expect(await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() })).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });

  it('control: the automatic mode still refuses the same never-sent package as unconfirmed', async () => {
    await world.seedPurgeable('p2');
    await world.db.run('UPDATE work_package SET server_confirmed = 0 WHERE inspection_id = ?', ['p2']);
    expect(await auto('p2')).toEqual({ kind: 'refused', reason: 'unconfirmed' });
  });

  it('a healthy server-confirmed package that is not quarantined is still refused as not_quarantined', async () => {
    await world.seedFull('p2');
    const hash = await world.hash();
    expect(await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(hash);
  });

  it("another account's queued write for the same inspection id stops the purge instead of being deleted", async () => {
    await world.seedFull('p2');
    await world.outbox('p2', 'pending', { account: BOB });
    expect(await confirmed('p2')).toEqual({ kind: 'failed', step: 'outbox', code: 'foreign_outbox' });
    expect(await world.db.query("SELECT user_id FROM outbox WHERE user_id = 'bob'")).toHaveLength(1);
  });
});

describe('the crash points: a failure after each step leaves a state the next run completes', () => {
  let fileBroken = false;

  interface Point {
    name: string;
    mode: 'auto' | 'user_confirmed';
    /** Deps whose Nth matching call fails. */
    deps: () => PurgeDeps;
    step: string;
    /** What must already be gone when it stopped. */
    gone: Partial<Record<InspectionTable | 'files', true>>;
    tombstone: number | null;
  }

  const points: Point[] = [
    { name: 'the tombstone write fails', mode: 'auto', deps: () => world.purgeDeps({ db: failingDb(world.db, /UPDATE work_package SET purging/, 1) }), step: 'tombstone', gone: {}, tombstone: 0 },
    { name: 'after the tombstone (the connector fails)', mode: 'auto', deps: () => world.purgeDeps({ connector: { closeFor: (id) => world.connector.closeFor(id), purge: () => Promise.reject(new Error('injected')) } }), step: 'connector', gone: {}, tombstone: 1 },
    {
      name: 'after the connector (a file cannot be removed)',
      mode: 'user_confirmed',
      deps: () => {
        const remove = world.files.remove.bind(world.files);
        world.files.remove = (path) => (fileBroken && path === 'media/p2-m2.jpg' ? Promise.reject(new Error('Unable to delete file')) : remove(path));
        fileBroken = true;
        return world.purgeDeps();
      },
      step: 'files',
      gone: { ydoc_updates: true, ydoc_sync: true },
      tombstone: 2,
    },
    { name: 'after the files (the cache delete fails)', mode: 'user_confirmed', deps: () => world.purgeDeps({ db: failingDb(world.db, /DELETE FROM resource_cache/, 1) }), step: 'cache', gone: { ydoc_updates: true, ydoc_sync: true, media: true, files: true }, tombstone: 2 },
    { name: 'after the cache (the outbox delete fails)', mode: 'user_confirmed', deps: () => world.purgeDeps({ db: failingDb(world.db, /DELETE FROM outbox/, 1) }), step: 'outbox', gone: { ydoc_updates: true, ydoc_sync: true, media: true, files: true, resource_cache: true }, tombstone: 2 },
    { name: 'after the outbox (the package row delete fails)', mode: 'user_confirmed', deps: () => world.purgeDeps({ db: failingDb(world.db, /DELETE FROM work_package/, 1) }), step: 'package', gone: { ydoc_updates: true, ydoc_sync: true, media: true, files: true, resource_cache: true, outbox: true }, tombstone: 2 },
    { name: 'after the cache, automatic (the package row delete fails)', mode: 'auto', deps: () => world.purgeDeps({ db: failingDb(world.db, /DELETE FROM work_package/, 1) }), step: 'package', gone: { ydoc_updates: true, ydoc_sync: true, resource_cache: true }, tombstone: 1 },
  ];

  it.each(points)('$name', async (point) => {
    const { before } = await threeWithTarget(point.mode === 'auto' ? 'purgeable' : 'full');
    const deps = point.deps();
    const outcome = point.mode === 'auto' ? await auto('p2', deps) : await confirmed('p2', deps);
    expect(outcome).toMatchObject({ kind: 'failed', step: point.step });

    // The state it stopped in: the parts that must be gone are gone, the rest is intact, the others never moved.
    const left = await world.counts('p2');
    for (const table of Object.keys(ZERO) as (InspectionTable | 'files')[]) {
      if (point.gone[table] === true) expect(left[table], table).toBe(table === 'work_package' ? 1 : 0);
    }
    await othersUnchanged(before);
    expect(await purgingOf('p2')).toBe(point.tombstone);

    // In none of those states may anything touch the inspection.
    if (point.tombstone !== 0) {
      await expect(world.connect('p2').persistenceSynced).rejects.toBeInstanceOf(CollabBlockedError);
      const refused = await enqueue({ db: world.db, clock: world.clock }, 'inspection.update', { inspectionId: 'p2', changes: { sqft: 1 } }, { account: ALICE }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ code: 'blocked' });
      expect(await replaceInspectionResources(world.db, { accountKey: accountKey(ALICE), inspectionId: 'p2', packageGen: 0, resources: new Map(), refreshedAt: 9 })).toBe('purging');
    }

    // The next run, with everything healthy again, completes it and leaves nothing behind.
    fileBroken = false;
    const healed = world.purgeDeps();
    const summary = await resumePurges({ ...healed, clock: world.clock, account: () => ALICE, isLocked: () => false });
    if (point.tombstone === 0) {
      expect(summary.resumed).toBe(0);
      expect(await purgingOf('p2')).toBe(0);
      expect(await world.counts('p2')).toEqual(left);
      return;
    }
    expect(summary).toMatchObject({ resumed: 1, failed: 0 });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect(world.files.paths().filter((p) => p.startsWith('media/p2'))).toEqual([]);
    expect(await world.db.query("SELECT key FROM resource_cache WHERE key LIKE '$refresh_error:p2'")).toEqual([]);
    await othersUnchanged(before);
  });
});

describe('resuming', () => {
  const resumeAll = (overrides: Partial<Parameters<typeof resumePurges>[0]> = {}) => resumePurges({ ...world.purgeDeps(), clock: world.clock, account: () => ALICE, isLocked: () => false, ...overrides });

  it('finishes a user-confirmed tombstone without asking the unsent predicate again', async () => {
    await world.seedFull('p2');
    await world.db.run('UPDATE work_package SET purging = 2 WHERE inspection_id = ?', ['p2']);
    expect(await resumeAll()).toMatchObject({ resumed: 1, failed: 0 });
    expect(await world.counts('p2')).toEqual(ZERO);
  });

  it('an automatic tombstone that now has a queued write or a photo is not finished: nothing more is deleted', async () => {
    await world.seedPurgeable('p2');
    await world.outbox('p2', 'pending');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    const before = await world.counts('p2');
    expect(await resume('p2')).toEqual({ kind: 'failed', step: 'tombstone', code: 'unexpected_data' });
    expect(await world.counts('p2')).toEqual(before);
    await world.db.run('DELETE FROM outbox');
    await world.mediaFile('p2', 'sneaky', 'pending');
    const withMedia = await world.counts('p2');
    expect(await resume('p2')).toEqual({ kind: 'failed', step: 'tombstone', code: 'unexpected_data' });
    expect(await world.counts('p2')).toEqual(withMedia);
  });

  it('control: the same automatic tombstone without them is finished', async () => {
    await world.seedPurgeable('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    expect(await resume('p2')).toEqual({ kind: 'purged' });
  });

  it('only resumes the signed-in account: the tombstone of another account and of nobody stays', async () => {
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    await world.seedPurgeable('p4');
    await world.db.run("UPDATE work_package SET purging = 1, user_id = 'bob' WHERE inspection_id = 'p3'");
    await world.db.run('UPDATE work_package SET purging = 1, tenant_id = NULL, user_id = NULL WHERE inspection_id = ?', ['p4']);
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    const keep = [await world.data('p3'), await world.data('p4')];
    expect(await resumeAll()).toMatchObject({ resumed: 1, foreign: 2 });
    expect([await world.data('p3'), await world.data('p4')]).toEqual(keep);
    expect((await world.counts('p2')).work_package).toBe(0);
  });

  it('does nothing while the device is locked, with no account, or while another flow holds the lease', async () => {
    await world.seedPurgeable('p2');
    await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', ['p2']);
    const hash = await world.hash();
    expect(await resumeAll({ isLocked: () => true })).toMatchObject({ resumed: 0, stopped: 'locked' });
    expect(await resumeAll({ isLocked: () => Promise.reject(new Error('unreadable')) })).toMatchObject({ resumed: 0, stopped: 'locked' });
    expect(await resumeAll({ account: () => null })).toMatchObject({ resumed: 0, stopped: 'no_account' });
    await world.db.run("INSERT INTO lease (name, holder, expires_at) VALUES ('sync', 'someone', ?)", [world.clock.now() + 30_000]);
    expect(await resumeAll()).toMatchObject({ resumed: 0, stopped: 'busy' });
    await world.db.run("DELETE FROM lease WHERE name = 'sync'");
    expect(await world.hash()).toBe(hash);
    expect(await resumeAll()).toMatchObject({ resumed: 1 });
  });

  it('stops between steps when the checkpoint says stop, leaving the tombstone', async () => {
    await world.seedFull('p2');
    let calls = 0;
    const outcome = await confirmed('p2', world.purgeDeps({ checkpoint: () => (calls += 1) < 3 }));
    expect(outcome).toMatchObject({ kind: 'failed', code: 'interrupted' });
    expect(await purgingOf('p2')).toBe(2);
    expect(await resume('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });

  it('a purge that already finished is not run again: a second call finds no package', async () => {
    await world.seedPurgeable('p2');
    await auto('p2');
    expect(await resume('p2')).toEqual({ kind: 'refused', reason: 'no_package' });
  });

  it('a stray document row written after the connector purge is swept in the transaction that deletes the package row', async () => {
    await world.seedFull('p2');
    const remove = world.files.remove.bind(world.files);
    world.files.remove = async (path) => {
      await remove(path);
      await world.ydoc('p2');
      await world.db.run("INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES ('results-p2', x'00', 1) ON CONFLICT(doc_name) DO NOTHING");
    };
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });
});

describe('a lock that arrives in the middle of a resume run', () => {
  const run = (isLocked: () => boolean | Promise<boolean>) => resumePurges({ ...world.purgeDeps(), clock: world.clock, account: () => ALICE, isLocked });
  const tombstoned = async (...ids: string[]): Promise<void> => {
    for (const id of ids) {
      await world.seedPurgeable(id);
      await world.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', [id]);
    }
  };
  const packageGone = async (id: string): Promise<boolean> => (await world.counts(id)).work_package === 0;

  it('between two inspections: the first is finished, the second is left tombstoned and untouched, and the run reports locked', async () => {
    await tombstoned('p2', 'p3');
    const second = await world.data('p3');
    const summary = await run(async () => packageGone('p2'));
    expect(summary).toMatchObject({ resumed: 1, failed: 0, stopped: 'locked' });
    expect(await world.data('p3')).toBe(second);
    expect((await world.counts('p3')).work_package).toBe(1);
  });

  it('inside one purge: the step after the lock stops it with the tombstone kept', async () => {
    await tombstoned('p2');
    let locked = false;
    const base = world.purgeDeps();
    const connector = {
      closeFor: (id: string) => base.connector.closeFor(id),
      purge: async (id: string) => {
        await base.connector.purge(id);
        locked = true;
      },
    };
    const summary = await resumePurges({ ...base, connector, clock: world.clock, account: () => ALICE, isLocked: () => locked });
    expect(summary).toMatchObject({ resumed: 0, failed: 1, stopped: 'locked', failures: { interrupted: 1 } });
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('control: a device that stays unlocked finishes both', async () => {
    await tombstoned('p2', 'p3');
    expect(await run(() => false)).toMatchObject({ resumed: 2, failed: 0, stopped: null });
  });
});

describe('the helpers the tests lean on', () => {
  it('the not-found test of the file adapter matches the memory double (so "already gone" is tested against the real rule)', async () => {
    const error = await world.files.remove('media/never-there.jpg').catch((e: unknown) => e);
    expect(isNotFoundError(error)).toBe(true);
  });
});
