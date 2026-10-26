import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { purgeInspection, type PurgeDeps, type PurgeOutcome } from './purge';
import { fingerprintOf } from './reconcile-decision';
import { issuePlanForTest, purgeAuthorityForTest } from './test-support/brands';
import { createPurgeWorld, type InspectionTable, type PurgeWorld } from './test-support/purge-world';
import { ALICE } from './test-support/reconcile-world';

let world: PurgeWorld;

beforeEach(async () => {
  world = await createPurgeWorld();
});

const ZERO: Record<InspectionTable | 'files', number> = { work_package: 0, outbox: 0, media: 0, ydoc_updates: 0, ydoc_sync: 0, resource_cache: 0, files: 0 };

async function auto(id: string, deps: PurgeDeps = world.purgeDeps()): Promise<PurgeOutcome> {
  return purgeInspection(deps, id, { mode: 'auto', account: ALICE, expectedFingerprint: await fingerprintOf(world.db, id) });
}
const confirmed = (id: string, deps: PurgeDeps = world.purgeDeps()): Promise<PurgeOutcome> => purgeInspection(deps, id, { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest() });
const resume = (id: string, deps: PurgeDeps = world.purgeDeps()): Promise<PurgeOutcome> => purgeInspection(deps, id, { mode: 'resume', account: ALICE, authority: purgeAuthorityForTest() });

const purgingOf = async (id: string): Promise<number | null> => {
  const rows = await world.db.query<{ purging: number }>('SELECT purging FROM work_package WHERE inspection_id = ?', [id]);
  return rows[0] === undefined ? null : Number(rows[0].purging);
};

/** Runs `inject` just before the n-th top-level transaction of the purge's own database handle (1 = the tombstone, 2 = the last). */
function injectingBeforeTransaction(nth: number, inject: () => Promise<void>): Db {
  let seen = 0;
  return {
    execute: (sql) => world.db.execute(sql),
    query: (sql, params) => world.db.query(sql, params),
    run: (sql, params) => world.db.run(sql, params),
    transaction: async (fn) => {
      seen += 1;
      if (seen === nth) await inject();
      return world.db.transaction(fn);
    },
  };
}

/** A connector whose `purge` first lets `inject` add data, as a writer that is still running would. */
function connectorInjecting(inject: (id: string) => Promise<void>): PurgeDeps['connector'] {
  return {
    closeFor: (id) => world.connector.closeFor(id),
    purge: async (id) => {
      await inject(id);
      await world.connector.purge(id);
    },
  };
}

describe('an AUTOMATIC purge never deletes data that appears after the tombstone', () => {
  it('a photo row and file that appear while the connection is being purged stop the purge: nothing of it is deleted', async () => {
    await world.seedPurgeable('p2');
    const deps = world.purgeDeps({ connector: connectorInjecting(async (id) => void (await world.mediaFile(id, 'late-photo', 'pending'))) });
    expect(await auto('p2', deps)).toEqual({ kind: 'failed', step: 'files', code: 'unexpected_data' });
    expect((await world.counts('p2')).media).toBe(1);
    expect(world.files.paths()).toContain('media/late-photo.jpg');
    // The tombstone stays, and a later resume refuses likewise instead of deleting the photo.
    expect(await purgingOf('p2')).toBe(1);
    expect(await resume('p2')).toEqual({ kind: 'failed', step: 'tombstone', code: 'unexpected_data' });
    expect((await world.counts('p2')).media).toBe(1);
    expect(world.files.paths()).toContain('media/late-photo.jpg');
  });

  it('the person-confirmed path still removes that photo, its file and the stuck purge', async () => {
    await world.seedPurgeable('p2');
    const deps = world.purgeDeps({ connector: connectorInjecting(async (id) => void (await world.mediaFile(id, 'late-photo', 'pending'))) });
    expect((await auto('p2', deps)).kind).toBe('failed');
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
    expect(world.files.paths()).not.toContain('media/late-photo.jpg');
  });

  it('control: a user-confirmed purge removes photos that were there from the start', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });

  it('a photo row that appears just before the last transaction is kept too', async () => {
    await world.seedPurgeable('p2');
    const db = injectingBeforeTransaction(2, async () => void (await world.mediaFile('p2', 'late-photo', 'pending')));
    expect(await auto('p2', world.purgeDeps({ db }))).toEqual({ kind: 'failed', step: 'media_rows', code: 'unexpected_data' });
    expect((await world.counts('p2')).media).toBe(1);
    expect((await world.counts('p2')).work_package).toBe(1);
    expect(world.files.paths()).toContain('media/late-photo.jpg');
  });

  it('a queued write that appears while the connection is being purged is kept, and the package row stays', async () => {
    await world.seedPurgeable('p2');
    const deps = world.purgeDeps({ connector: connectorInjecting((id) => world.outbox(id, 'pending')) });
    expect(await auto('p2', deps)).toEqual({ kind: 'failed', step: 'outbox', code: 'unexpected_data' });
    expect((await world.counts('p2')).outbox).toBe(1);
    expect((await world.counts('p2')).work_package).toBe(1);
    expect(await purgingOf('p2')).toBe(1);
  });

  it('a queued write that appears just before the last transaction is kept, and the package row stays', async () => {
    await world.seedPurgeable('p2');
    const db = injectingBeforeTransaction(2, () => world.outbox('p2', 'pending'));
    expect(await auto('p2', world.purgeDeps({ db }))).toEqual({ kind: 'failed', step: 'outbox', code: 'unexpected_data' });
    expect((await world.counts('p2')).outbox).toBe(1);
    expect((await world.counts('p2')).work_package).toBe(1);
  });

  it('control: with nothing appearing, the same injection point lets the purge finish', async () => {
    await world.seedPurgeable('p2');
    const db = injectingBeforeTransaction(2, () => Promise.resolve());
    expect(await auto('p2', world.purgeDeps({ db }))).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });
});

describe('resume only continues a purge that was decided', () => {
  it('a quarantined inspection that is NOT tombstoned is refused and nothing is deleted', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    const before = await world.hash();
    expect(await resume('p2')).toEqual({ kind: 'refused', reason: 'not_tombstoned' });
    expect(await world.hash()).toBe(before);
  });

  it('control: once tombstoned by the person, the same call finishes it', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    await world.db.run('UPDATE work_package SET purging = 2 WHERE inspection_id = ?', ['p2']);
    expect(await resume('p2')).toEqual({ kind: 'purged' });
    expect(await world.counts('p2')).toEqual(ZERO);
  });
});

describe('the live editor stops writing before anything else of a purge happens', () => {
  it('the connection is closed before the editor is told, and an edit made while it is told is not persisted', async () => {
    await world.seedPurgeable('p2');
    const handle = world.connect('p2');
    await handle.persistenceSynced;
    const order: string[] = [];
    let rowsAtPurge = -1;
    let rowsBeforeEdit = -1;
    const deps = world.purgeDeps({
      connector: {
        closeFor: async (id) => {
          order.push('closeFor');
          await world.connector.closeFor(id);
        },
        purge: async (id) => {
          order.push('purge');
          rowsAtPurge = (await world.counts('p2')).ydoc_updates;
          await world.connector.purge(id);
        },
      },
      onPurging: async () => {
        order.push('onPurging');
        rowsBeforeEdit = (await world.counts('p2')).ydoc_updates;
        handle.doc.getMap('m').set('late', 'edit');
        // Let every queued database statement run before the purge goes on.
        for (let i = 0; i < 5; i += 1) await world.db.query('SELECT 1');
      },
    });
    expect(await auto('p2', deps)).toEqual({ kind: 'purged' });
    expect(order).toEqual(['closeFor', 'onPurging', 'purge']);
    expect(rowsAtPurge).toBe(rowsBeforeEdit);
    const left = await world.counts('p2');
    expect(left.ydoc_updates).toBe(0);
    expect(left.ydoc_sync).toBe(0);
  });

  it('a connection that cannot be closed stops the purge with the tombstone kept', async () => {
    await world.seedPurgeable('p2');
    const deps = world.purgeDeps({
      connector: {
        closeFor: () => Promise.reject(new Error('cannot close /private/path')),
        purge: world.connector.purge,
      },
    });
    const out = await auto('p2', deps);
    expect(out).toEqual({ kind: 'failed', step: 'connector', code: 'storage_failed' });
    expect(world.purgingSignals).toEqual([]);
    expect(await purgingOf('p2')).toBe(1);
  });
});

describe('the exported wipe cannot be reached without its authority or on a healthy inspection', () => {
  it('user_confirmed on a healthy inspection (not quarantined) is refused and nothing changes', async () => {
    await world.seedFull('p2');
    const before = await world.hash();
    expect(await confirmed('p2')).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(before);
    expect(world.files.paths()).toContain('media/p2-m1.jpg');
  });

  it('control: the same call on the same inspection once it is quarantined purges it', async () => {
    await world.seedFull('p2');
    await world.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'p2'");
    expect(await confirmed('p2')).toEqual({ kind: 'purged' });
  });

  it('user_confirmed without the authority is refused even for a quarantined inspection', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    const before = await world.hash();
    const out = await purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE } as never);
    expect(out).toEqual({ kind: 'refused', reason: 'not_authorized' });
    expect(await world.hash()).toBe(before);
  });

  it('resume without the authority is refused even for a tombstoned inspection', async () => {
    await world.seedFull('p2', { quarantine: 'reconcile_missing' });
    await world.db.run('UPDATE work_package SET purging = 2 WHERE inspection_id = ?', ['p2']);
    const before = await world.hash();
    for (const authority of [undefined, {}, 'authority', Symbol('x')]) {
      const out = await purgeInspection(world.purgeDeps(), 'p2', { mode: 'resume', account: ALICE, authority } as never);
      expect(out).toEqual({ kind: 'refused', reason: 'not_authorized' });
    }
    expect(await world.hash()).toBe(before);
  });

  it('a mass-suspicious plan reference lets a healthy inspection through only when it is an ISSUED plan that names it', async () => {
    await world.seedPurgeable('p1');
    await world.seedPurgeable('p2');
    await world.seedPurgeable('p3');
    world.server.hidden = new Set(['p1', 'p2', 'p3']);
    const result = await world.decide();
    if (result.kind !== 'plan') throw new Error('expected a plan');
    const before = await world.hash();
    const withPlan = (plan: unknown): Promise<PurgeOutcome> => purgeInspection(world.purgeDeps(), 'p2', { mode: 'user_confirmed', account: ALICE, authority: purgeAuthorityForTest(), plan } as never);
    // A copy of the real plan, and a hand-built one with the same content, are not the issued plan.
    expect(await withPlan({ ...result })).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await withPlan(JSON.parse(JSON.stringify(result)))).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    // An issued plan that does not name this id, or is not about a suspicious answer, does not either.
    expect(await withPlan(issuePlanForTest({ ...result, quarantine: ['p1'] }))).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await withPlan(issuePlanForTest({ ...result, massSuspicious: false }))).toEqual({ kind: 'refused', reason: 'not_quarantined' });
    expect(await world.hash()).toBe(before);
    // The real, issued plan does.
    expect(await withPlan(result)).toEqual({ kind: 'purged' });
    expect((await world.counts('p2')).work_package).toBe(0);
    expect((await world.counts('p1')).work_package).toBe(1);
  });
});
