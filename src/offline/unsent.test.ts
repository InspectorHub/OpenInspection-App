import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordServerStateVector } from '../collab/sync-proof';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import type { Account } from './outbox';
import { unattributableOutboxRows, unsentData } from './unsent';

const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function package_(id: string, o: { confirmed?: number; account?: Account | null } = {}): Promise<void> {
  const account = o.account === undefined ? ALICE : o.account;
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, 1, ?, ?, ?)', [id, o.confirmed ?? 1, account?.tenantId ?? null, account?.userId ?? null]);
}

let seq = 0;
async function outbox(id: string | null, state = 'pending', o: { account?: Account; op?: string } = {}): Promise<void> {
  const account = o.account ?? ALICE;
  seq += 1;
  await db.run(
    "INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES (?, ?, ?, '{}', ?, 1, ?, 1, ?, ?)",
    [`key-${String(seq)}`, seq, o.op ?? 'inspection.update', state, id, account.tenantId, account.userId],
  );
}

let mediaN = 0;
async function media(id: string, state: string): Promise<void> {
  mediaN += 1;
  await db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, 'photo', 'media/x.jpg', 'image/jpeg', '{}', ?, 1)", [`pending-${String(mediaN)}`, id, state]);
}

function editedRows(): Uint8Array[] {
  const doc = new Y.Doc();
  const rows: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => rows.push(u));
  doc.getMap<unknown>('m').set('k', 1);
  return rows;
}

async function ydoc(id: string, rows = editedRows()): Promise<Uint8Array[]> {
  for (const data of rows) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${id}`, data]);
  return rows;
}

describe('the baseline: nothing stored means nothing to lose', () => {
  it('reports no unsent data for an inspection with only its package row', async () => {
    await package_('insp-1');
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result).toMatchObject({ unsent: false, unknown: false, reasons: [] });
    expect(result.counts.outbox).toEqual({ pending: 0, failed: 0, orphaned: 0, other: 0 });
    expect(result.counts.ydocRows).toBe(0);
  });

  it('reports no unsent data for an inspection that has no package row either', async () => {
    expect((await unsentData(db, 'insp-1', ALICE)).unsent).toBe(false);
  });

  it('refuses an id that could not be an inspection id', async () => {
    await expect(unsentData(db, 'not an id', ALICE)).rejects.toThrow(RangeError);
  });
});

let tagN = 0;
async function tag(id: string, state: string, o: { account?: Account; item?: string } = {}): Promise<void> {
  tagN += 1;
  const account = o.account ?? ALICE;
  await db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, ?, ?, ?, 'Urgent', NULL, ?, 1)", [
    `${account.tenantId}:${account.userId}`,
    id,
    o.item ?? 'item-1',
    `tag-${String(tagN)}`,
    state,
  ]);
}

// A tag change the server has not been told about is work that would be lost. It is not in the queue (it is a set of rows,
// not an ordered line), so without its own check removing the inspection, or an automatic purge, would drop it unseen.
describe('tag changes the server has not been told about count', () => {
  it.each(['add', 'remove'])('a tag row waiting to %s is unsent', async (state) => {
    await package_('insp-1');
    await tag('insp-1', state);
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result).toMatchObject({ unsent: true, unknown: false, reasons: ['tags_not_on_server'] });
    expect(result.counts.tags).toBe(1);
  });

  it('counts every waiting row, and only this inspection\'s', async () => {
    await package_('insp-1');
    await tag('insp-1', 'add', { item: 'a' });
    await tag('insp-1', 'remove', { item: 'b' });
    await tag('insp-2', 'add');
    expect((await unsentData(db, 'insp-1', ALICE)).counts.tags).toBe(2);
    expect((await unsentData(db, 'insp-2', ALICE)).counts.tags).toBe(1);
  });

  it('a tag the server already has is not unsent', async () => {
    await package_('insp-1');
    await tag('insp-1', 'synced');
    expect(await unsentData(db, 'insp-1', ALICE)).toMatchObject({ unsent: false, reasons: [] });
    expect((await unsentData(db, 'insp-1', ALICE)).counts.tags).toBe(0);
  });

  it('counts the rows of every account, not only the signed-in one', async () => {
    await package_('insp-1');
    await tag('insp-1', 'add', { account: BOB });
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['tags_not_on_server']);
  });
});

describe('queued writes count in every state', () => {
  it.each([
    ['pending', 'outbox_pending'],
    ['failed', 'outbox_failed'],
    ['orphaned', 'outbox_orphaned'],
    ['some-future-state', 'outbox_other'],
  ])('a %s row is unsent data (%s)', async (state, reason) => {
    await package_('insp-1');
    await outbox('insp-1', state);
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.unsent).toBe(true);
    expect(result.reasons).toEqual([reason]);
  });

  it('counts every state separately', async () => {
    await outbox('insp-1', 'pending');
    await outbox('insp-1', 'pending');
    await outbox('insp-1', 'failed');
    await outbox('insp-1', 'orphaned');
    expect((await unsentData(db, 'insp-1', ALICE)).counts.outbox).toEqual({ pending: 2, failed: 1, orphaned: 1, other: 0 });
  });

  it('control: rows of another inspection do not count', async () => {
    await outbox('insp-2', 'pending');
    expect((await unsentData(db, 'insp-1', ALICE)).unsent).toBe(false);
  });

  it('rows queued by another account on the same device still count: they are somebody\'s unsent work', async () => {
    await outbox('insp-1', 'pending', { account: BOB });
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['outbox_pending']);
  });
});

describe('a queued write without a usable inspection id', () => {
  it('makes the answer unknown for every inspection, whatever else is stored', async () => {
    await package_('insp-1');
    await outbox(null, 'pending');
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.unknown).toBe(true);
    expect(result.unsent).toBe(true);
    expect(result.reasons).toContain('outbox_unattributable');
    expect((await unsentData(db, 'never-seen', ALICE)).unknown).toBe(true);
  });

  it('control: the same database without that row is known and has nothing unsent', async () => {
    await package_('insp-1');
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result).toMatchObject({ unknown: false, unsent: false });
    expect(await unattributableOutboxRows(db)).toBe(0);
  });

  it.each([['an empty string', ''], ['a value outside the id charset', 'bad id!'], ['a reserved route segment', 'bulk'], ['a value that is too long', 'x'.repeat(65)]])('%s is no inspection id either', async (_name, value) => {
    await outbox(value, 'failed');
    expect(await unattributableOutboxRows(db)).toBe(1);
    expect((await unsentData(db, 'insp-1', ALICE)).unknown).toBe(true);
  });

  it('counts the rows of every state, including failed and orphaned ones', async () => {
    await outbox(null, 'failed');
    await outbox(null, 'orphaned');
    await outbox('ok-1', 'pending');
    expect(await unattributableOutboxRows(db)).toBe(2);
  });

  it('is decided by the column alone: a payload that names an inspection does not rescue the row', async () => {
    await db.run(
      "INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id) VALUES ('k', 1, 'inspection.update', '{\"inspectionId\":\"insp-1\"}', 'pending', 1, NULL, 1, 'tenant-1', 'alice')",
    );
    expect((await unsentData(db, 'insp-1', ALICE)).unknown).toBe(true);
  });
});

describe('media rows', () => {
  it.each([
    ['pending', 'media_not_uploaded'],
    ['uploading', 'media_not_uploaded'],
    ['failed', 'media_not_uploaded'],
    ['uploaded', 'media_uploaded_unresolved'],
    ['archived', 'media_unknown_state'],
  ])('a %s row is unsent data (%s)', async (state, reason) => {
    await media('insp-1', state);
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.unsent).toBe(true);
    expect(result.reasons).toEqual([reason]);
  });

  it('control: media of another inspection does not count, and no media row means no media reason', async () => {
    await media('insp-2', 'pending');
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual([]);
  });

  it('counts photos by kind of state', async () => {
    await media('insp-1', 'pending');
    await media('insp-1', 'uploaded');
    await media('insp-1', 'weird');
    expect((await unsentData(db, 'insp-1', ALICE)).counts.media).toEqual({ notUploaded: 1, uploaded: 1, unknownState: 1 });
  });
});

describe('the stored document', () => {
  it('is unsent while no marker proves the server holds it', async () => {
    await ydoc('insp-1');
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.reasons).toEqual(['ydoc_not_on_server']);
    expect(result.counts.ydocRows).toBe(1);
    expect(result.counts.ydocCovered).toBe(false);
  });

  it('control: the identical rows are not unsent once the server state vector covers them', async () => {
    const rows = await ydoc('insp-1');
    const server = new Y.Doc();
    for (const row of rows) Y.applyUpdate(server, row);
    await recordServerStateVector(db, 'results-insp-1', Y.encodeStateVector(server), 1);
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.unsent).toBe(false);
    expect(result.counts.ydocRows).toBe(1);
    expect(result.counts.ydocCovered).toBe(true);
  });

  it('a marker taken before a later edit does not cover it', async () => {
    const rows = await ydoc('insp-1');
    const server = new Y.Doc();
    for (const row of rows) Y.applyUpdate(server, row);
    await recordServerStateVector(db, 'results-insp-1', Y.encodeStateVector(server), 1);
    const more = new Y.Doc();
    Y.applyUpdate(more, rows[0] as Uint8Array);
    const later: Uint8Array[] = [];
    more.on('update', (u: Uint8Array) => later.push(u));
    more.getMap<unknown>('m').set('later', 2);
    await ydoc('insp-1', later);
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['ydoc_not_on_server']);
  });

  it('a document with only an empty update has nothing to lose', async () => {
    await ydoc('insp-1', [Y.encodeStateAsUpdate(new Y.Doc())]);
    expect((await unsentData(db, 'insp-1', ALICE)).unsent).toBe(false);
  });

  it('control: another inspection\'s document is not this one\'s', async () => {
    await ydoc('insp-2');
    expect((await unsentData(db, 'insp-1', ALICE)).unsent).toBe(false);
  });
});

describe('an inspection created on the device', () => {
  it('is unsent by definition until the server acknowledged the create', async () => {
    await package_('insp-1', { confirmed: 0 });
    const result = await unsentData(db, 'insp-1', ALICE);
    expect(result.reasons).toEqual(['created_locally']);
    expect(result.counts.createdLocally).toBe(true);
  });

  it('control: the confirmed package of the same account has no such reason', async () => {
    await package_('insp-1', { confirmed: 1 });
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual([]);
  });

  it('a package owned by another account, or by nobody, is not this account\'s to judge', async () => {
    await package_('insp-1', { account: BOB });
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['package_owner_mismatch']);
    await db.run('DELETE FROM work_package');
    await package_('insp-1', { account: null });
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['package_owner_mismatch']);
  });
});

describe('reasons add up, in a fixed order', () => {
  it('lists every reason that applies', async () => {
    await package_('insp-1', { confirmed: 0 });
    await outbox('insp-1', 'pending');
    await media('insp-1', 'pending');
    await ydoc('insp-1');
    expect((await unsentData(db, 'insp-1', ALICE)).reasons).toEqual(['outbox_pending', 'media_not_uploaded', 'ydoc_not_on_server', 'created_locally']);
  });
});

describe('one consistent read', () => {
  it('reads inside a single transaction, never on the connection outside it', async () => {
    let outside = 0;
    let inside = 0;
    let transactions = 0;
    const counted = (inner: Db, isTx: boolean): Db => ({
      execute: inner.execute.bind(inner),
      run: inner.run.bind(inner),
      query: (sql, params) => {
        if (isTx) inside += 1;
        else outside += 1;
        return inner.query(sql, params);
      },
      transaction: (fn) => {
        transactions += 1;
        return inner.transaction((tx) => fn(counted(tx, true)));
      },
    });
    await unsentData(counted(db, false), 'insp-1', ALICE);
    expect(transactions).toBe(1);
    expect(outside).toBe(0);
    expect(inside).toBeGreaterThanOrEqual(5);
  });

  it('a write that arrives while it runs is not seen half-way: the answer describes the state before it', async () => {
    await package_('insp-1');
    const answer = unsentData(db, 'insp-1', ALICE);
    const write = db.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES ('late', 'insp-1', 'photo', 'media/x.jpg', 'image/jpeg', '{}', 'pending', 1)");
    expect((await answer).unsent).toBe(false);
    await write;
    expect((await unsentData(db, 'insp-1', ALICE)).unsent).toBe(true);
  });
});
