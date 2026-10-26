import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { createManualTimers, type ManualTimers } from './test-support/manual-timers';
import { COMPACTION_DEBOUNCE_MS, PREFERRED_TRIM_SIZE, SqlitePersistence, isValidDocName } from './y-sqlite';

let db: Db;
let timers: ManualTimers;
let errors: unknown[];

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  timers = createManualTimers();
  errors = [];
});

function open(target: Db, name: string, doc: Y.Doc): SqlitePersistence {
  return new SqlitePersistence(target, name, doc, { timers, onError: (err) => errors.push(err) });
}

async function opened(name: string, doc = new Y.Doc(), target: Db = db): Promise<SqlitePersistence> {
  const persistence = open(target, name, doc);
  await persistence.whenSynced;
  return persistence;
}

async function count(name?: string): Promise<number> {
  const rows =
    name === undefined
      ? await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates')
      : await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [name]);
  return Number(rows[0]?.n);
}

function setKey(doc: Y.Doc, key: string, value: unknown): void {
  doc.getMap<unknown>('m').set(key, value);
}

function content(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap<unknown>('m').toJSON() as Record<string, unknown>;
}

/** A Db whose statements can be made to fail or wait, to put the persistence on its failure paths. */
interface Faults {
  failRun?: (sql: string) => boolean;
  failQuery?: boolean;
  failInTransaction?: (sql: string) => boolean;
  gateTransaction?: Promise<void>;
  gateRun?: Promise<void>;
}

function faulty(real: Db, faults: Faults): Db {
  return {
    execute: (sql) => real.execute(sql),
    query: (sql, params) => (faults.failQuery ? Promise.reject(new Error('query failed')) : real.query(sql, params)),
    run: async (sql, params) => {
      if (faults.gateRun && sql.startsWith('INSERT')) await faults.gateRun;
      if (faults.failRun?.(sql)) throw new Error('write failed');
      return real.run(sql, params);
    },
    transaction: (fn) =>
      real.transaction(async (tx) => {
        if (faults.gateTransaction) await faults.gateTransaction;
        return fn({
          ...tx,
          run: (sql, params) => (faults.failInTransaction?.(sql) ? Promise.reject(new Error('delete failed')) : tx.run(sql, params)),
        });
      }),
  };
}

function gate(): { promise: Promise<void>; open(): void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, open: release };
}

describe('SqlitePersistence: loading and storing', () => {
  it('restores the content a previous document wrote', async () => {
    const first = new Y.Doc();
    const writer = await opened('results-a', first);
    setKey(first, 'k', 'v');
    setKey(first, 'n', 1);
    await writer.flush();
    expect(await count('results-a')).toBe(2);

    const second = new Y.Doc();
    const reader = open(db, 'results-a', second);
    expect(await reader.whenSynced).toBe(reader);
    expect(content(second)).toEqual({ k: 'v', n: 1 });
  });

  it('does not grow the table when the same document is reopened ten times', async () => {
    const first = new Y.Doc();
    const writer = await opened('results-a', first);
    setKey(first, 'a', 1);
    setKey(first, 'b', 2);
    setKey(first, 'c', 3);
    await writer.flush();
    await writer.destroy();
    const before = await count('results-a');
    expect(before).toBe(3);

    for (let i = 0; i < 10; i += 1) {
      const doc = new Y.Doc();
      const reopened = await opened('results-a', doc);
      expect(content(doc)).toEqual({ a: 1, b: 2, c: 3 });
      await reopened.flush();
      await reopened.destroy();
      expect(await count('results-a')).toBe(before);
    }
    expect(errors).toEqual([]);
  });

  it('does not store an update applied with the persistence as its origin, and stores the same update from any other origin', async () => {
    const source = new Y.Doc();
    setKey(source, 'k', 'v');
    const update = Y.encodeStateAsUpdate(source);

    const own = new Y.Doc();
    const ownPersistence = await opened('results-own', own);
    Y.applyUpdate(own, update, ownPersistence);
    await ownPersistence.flush();
    expect(content(own)).toEqual({ k: 'v' });
    expect(await count('results-own')).toBe(0);

    const other = new Y.Doc();
    const otherPersistence = await opened('results-other', other);
    Y.applyUpdate(other, update, 'socket');
    await otherPersistence.flush();
    expect(await count('results-other')).toBe(1);
  });

  it('stores a document that already had content before it was opened, once', async () => {
    const doc = new Y.Doc();
    setKey(doc, 'early', true);
    const persistence = await opened('results-a', doc);
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
    await persistence.destroy();

    const again = new Y.Doc();
    const reopened = await opened('results-a', again);
    await reopened.flush();
    expect(content(again)).toEqual({ early: true });
    expect(await count('results-a')).toBe(1);
  });

  it('writes no row when an empty document is opened, and one row per later edit', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await persistence.flush();
    expect(await count()).toBe(0);

    setKey(doc, 'k', 'v');
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
  });

  it('keeps two documents apart when their edits interleave', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-b', b);
    for (let i = 0; i < 5; i += 1) {
      setKey(a, `a${String(i)}`, i);
      setKey(b, `b${String(i)}`, i);
    }
    await pa.flush();
    await pb.flush();
    expect(await count('results-a')).toBe(5);
    expect(await count('results-b')).toBe(5);

    const ra = new Y.Doc();
    const rb = new Y.Doc();
    await opened('results-a', ra);
    await opened('results-b', rb);
    expect(Object.keys(content(ra)).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(Object.keys(content(rb)).sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
  });

  it('round-trips binary updates containing every byte value', async () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
    await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['raw', everyByte]);
    const rows = await db.query<{ data: Uint8Array }>('SELECT data FROM ydoc_updates WHERE doc_name = ?', ['raw']);
    expect(Array.from(rows[0]?.data ?? [])).toEqual(Array.from(everyByte));

    const first = new Y.Doc();
    const writer = await opened('results-bin', first);
    setKey(first, 'bytes', everyByte);
    await writer.flush();

    const second = new Y.Doc();
    await opened('results-bin', second);
    const restored = second.getMap<Uint8Array>('m').get('bytes');
    expect(Array.from(restored ?? [])).toEqual(Array.from(everyByte));
  });
});

describe('SqlitePersistence: destroy and clearData', () => {
  it('stops writing after destroy, and wrote before it', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    setKey(doc, 'before', 1);
    await persistence.flush();
    expect(await count('results-a')).toBe(1);

    await persistence.destroy();
    setKey(doc, 'after', 2);
    setKey(doc, 'after2', 3);
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
  });

  it('unbinds exactly the handlers it registered', async () => {
    const doc = new Y.Doc();
    const on = vi.spyOn(doc, 'on');
    const off = vi.spyOn(doc, 'off');
    const persistence = await opened('results-a', doc);
    await persistence.destroy();
    for (const event of ['update', 'destroy'] as const) {
      const registered = on.mock.calls.filter(([name]) => name === event).map(([, handler]) => handler);
      const released = off.mock.calls.filter(([name]) => name === event).map(([, handler]) => handler);
      expect(registered).toHaveLength(1);
      expect(released).toEqual(registered);
    }
  });

  it('stops writing when the document itself is destroyed', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    setKey(doc, 'before', 1);
    await persistence.flush();
    doc.destroy();
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('applies nothing when destroyed before the stored state was read', async () => {
    const first = new Y.Doc();
    const writer = await opened('results-a', first);
    setKey(first, 'k', 'v');
    await writer.flush();

    const second = new Y.Doc();
    const racing = open(db, 'results-a', second);
    await racing.destroy();
    expect(content(second)).toEqual({});
  });

  it('waits for writes already started before its promise settles', async () => {
    const hold = gate();
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc, faulty(db, { gateRun: hold.promise }));
    setKey(doc, 'k', 'v');
    let settled = false;
    const destroyed = persistence.destroy().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await count('results-a')).toBe(0);
    hold.open();
    await destroyed;
    expect(await count('results-a')).toBe(1);
  });

  it('clearData deletes that document rows and leaves another document alone', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-b', b);
    setKey(a, 'k', 1);
    setKey(a, 'j', 2);
    setKey(b, 'k', 3);
    await pa.flush();
    await pb.flush();
    expect(await count('results-a')).toBe(2);
    expect(await count('results-b')).toBe(1);

    await pa.clearData();
    expect(await count('results-a')).toBe(0);
    expect(await count('results-b')).toBe(1);

    setKey(a, 'later', 4);
    await pa.flush();
    expect(await count('results-a')).toBe(0);
  });

  it('treats an underscore in a name as a literal character, never as a pattern', async () => {
    const lookalike = new Y.Doc();
    const real = new Y.Doc();
    const pl = await opened('results-aXb', lookalike);
    const pr = await opened('results-a_b', real);
    setKey(lookalike, 'k', 1);
    setKey(real, 'k', 2);
    await pl.flush();
    await pr.flush();

    await pr.clearData();
    expect(await count('results-a_b')).toBe(0);
    expect(await count('results-aXb')).toBe(1);
  });
});

describe('doc names', () => {
  it('accepts the characters of an inspection id and rejects everything else', () => {
    expect(isValidDocName('results-abc_DEF-123')).toBe(true);
    for (const bad of ['', 'a/b', "a' OR '1'='1", 'a%', 'a b', 'a;b', 'ünï', 'a\u0000b', 'x'.repeat(73)]) {
      expect(isValidDocName(bad)).toBe(false);
    }
  });

  it('refuses to construct a persistence for an invalid name, and touches nothing', async () => {
    const doc = new Y.Doc();
    for (const bad of ['', 'a/b', "x' OR '1'='1", '%', 'a b']) {
      expect(() => open(db, bad, doc)).toThrow(RangeError);
    }
    setKey(doc, 'k', 1);
    expect(await count()).toBe(0);
    await expect(opened('results-ok', new Y.Doc())).resolves.toBeInstanceOf(SqlitePersistence);
  });
});

describe('SqlitePersistence: compaction', () => {
  async function editMany(doc: Y.Doc, total: number): Promise<void> {
    for (let i = 0; i < total; i += 1) setKey(doc, `k${String(i)}`, i);
  }

  it('schedules a debounced compaction only once the trim size is reached', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await editMany(doc, PREFERRED_TRIM_SIZE - 1);
    expect(timers.pending()).toBe(0);

    setKey(doc, 'last', 1);
    expect(timers.pending()).toBe(1);
    setKey(doc, 'more', 2);
    setKey(doc, 'more2', 3);
    expect(timers.pending()).toBe(1);
    expect(timers.delays()).toEqual([COMPACTION_DEBOUNCE_MS]);
    await persistence.destroy();
    expect(timers.pending()).toBe(0);
  });

  it('collapses more than 500 updates into one row with identical content', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await editMany(doc, PREFERRED_TRIM_SIZE + 1);
    await persistence.flush();
    expect(await count('results-a')).toBe(PREFERRED_TRIM_SIZE + 1);

    timers.fireNext();
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
    expect(errors).toEqual([]);

    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)).toEqual(content(doc));
    expect(Object.keys(content(restored))).toHaveLength(PREFERRED_TRIM_SIZE + 1);
  });

  it('counts rows again after a compaction, so the next batch compacts too', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await editMany(doc, PREFERRED_TRIM_SIZE);
    timers.fireNext();
    await persistence.flush();
    expect(await count('results-a')).toBe(1);

    for (let i = 0; i < PREFERRED_TRIM_SIZE - 2; i += 1) setKey(doc, `again${String(i)}`, i);
    expect(timers.pending()).toBe(0);
    setKey(doc, 'again-last', 1);
    expect(timers.pending()).toBe(1);
  });

  it('leaves the old rows intact and reports the error when a compaction fails part way', async () => {
    const doc = new Y.Doc();
    const failing = faulty(db, { failInTransaction: (sql) => sql.startsWith('DELETE') });
    const persistence = await opened('results-a', doc, failing);
    await editMany(doc, PREFERRED_TRIM_SIZE + 1);
    await persistence.flush();

    timers.fireNext();
    await persistence.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('delete failed');
    expect(await count('results-a')).toBe(PREFERRED_TRIM_SIZE + 1);

    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)).toEqual(content(doc));
  });

  it('loses no edit made while a compaction is running', async () => {
    const hold = gate();
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc, faulty(db, { gateTransaction: hold.promise }));
    await editMany(doc, PREFERRED_TRIM_SIZE);
    await persistence.flush();

    timers.fireNext();
    setKey(doc, 'during-1', 'x');
    setKey(doc, 'during-2', 'y');
    setKey(doc, 'during-3', 'z');
    hold.open();
    await persistence.flush();

    expect(errors).toEqual([]);
    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)).toEqual(content(doc));
    expect(content(restored)).toMatchObject({ 'during-1': 'x', 'during-2': 'y', 'during-3': 'z' });
    expect(await count('results-a')).toBeLessThanOrEqual(4);
  });

  it('does not touch another document when one compacts', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-b', b);
    setKey(b, 'k', 1);
    setKey(b, 'j', 2);
    await editMany(a, PREFERRED_TRIM_SIZE);
    timers.fireNext();
    await pa.flush();
    await pb.flush();
    expect(await count('results-a')).toBe(1);
    expect(await count('results-b')).toBe(2);
  });
});

describe('SqlitePersistence: a second instance on the same document', () => {
  async function editMany(doc: Y.Doc, total: number): Promise<void> {
    for (let i = 0; i < total; i += 1) setKey(doc, `k${String(i)}`, i);
  }

  it('keeps rows another instance wrote after this one loaded, and merges them into its document', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-a', b);
    setKey(b, 'from-b', 'kept');
    await pb.flush();
    await editMany(a, PREFERRED_TRIM_SIZE);
    await pa.flush();

    timers.fireNext();
    await pa.flush();
    expect(errors).toEqual([]);
    expect(content(a)['from-b']).toBe('kept');

    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)['from-b']).toBe('kept');
    expect(content(restored)).toEqual(content(a));
  });

  it('keeps a row the other instance wrote after the compaction was requested but before it ran', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-a', b);
    await editMany(a, PREFERRED_TRIM_SIZE);
    await pa.flush();

    const hold = gate();
    const blocker = db.transaction(async () => {
      await hold.promise;
    });
    setKey(b, 'from-b', 'between');
    timers.fireNext();
    hold.open();
    await blocker;
    await pa.flush();
    await pb.flush();

    expect(errors).toEqual([]);
    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)['from-b']).toBe('between');
    expect(content(restored)).toEqual(content(a));
  });

  it('keeps a row the other instance wrote after the compaction ran', async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const pa = await opened('results-a', a);
    const pb = await opened('results-a', b);
    await editMany(a, PREFERRED_TRIM_SIZE);
    timers.fireNext();
    await pa.flush();
    setKey(b, 'after', true);
    await pb.flush();

    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)['after']).toBe(true);
    expect(Object.keys(content(restored))).toHaveLength(PREFERRED_TRIM_SIZE + 1);
  });

  it('a lone instance still ends with exactly one row, and the compaction after it also does', async () => {
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await editMany(doc, PREFERRED_TRIM_SIZE);
    timers.fireNext();
    await persistence.flush();
    expect(await count('results-a')).toBe(1);

    await editMany(doc, PREFERRED_TRIM_SIZE);
    timers.fireNext();
    await persistence.flush();
    expect(await count('results-a')).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('SqlitePersistence: row accounting and the ready guard', () => {
  it('stores an edit made before the stored state was applied exactly once, together with that state', async () => {
    const seed = new Y.Doc();
    const writer = await opened('results-a', seed);
    setKey(seed, 'stored', 1);
    await writer.flush();

    const doc = new Y.Doc();
    const persistence = open(db, 'results-a', doc);
    setKey(doc, 'early', 2);
    await persistence.whenSynced;
    await persistence.flush();
    expect(await count('results-a')).toBe(2);
    expect(content(doc)).toEqual({ stored: 1, early: 2 });

    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)).toEqual({ stored: 1, early: 2 });
  });

  it('counts the inserts issued while a compaction waited for the connection', async () => {
    const hold = gate();
    const hurt = { on: true };
    const doc = new Y.Doc();
    const persistence = await opened(
      'results-a',
      doc,
      faulty(db, { gateTransaction: hold.promise, failRun: (sql) => hurt.on && sql.startsWith('INSERT') }),
    );
    setKey(doc, 'lost-write', 1);
    await persistence.flush();
    expect(errors).toHaveLength(1);
    hurt.on = false;

    timers.fireNext();
    setKey(doc, 'during-1', 1);
    setKey(doc, 'during-2', 2);
    setKey(doc, 'during-3', 3);
    hold.open();
    await persistence.flush();
    expect(await count('results-a')).toBe(4);

    for (let i = 0; i < PREFERRED_TRIM_SIZE - 5; i += 1) setKey(doc, `more${String(i)}`, i);
    expect(timers.pending()).toBe(0);
    setKey(doc, 'last', 1);
    expect(timers.pending()).toBe(1);
  });

  it('does not compact because of a reload, and compacts on the first edit after reloading a full table', async () => {
    const seed = new Y.Doc();
    const updates: Uint8Array[] = [];
    seed.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    for (let i = 0; i < PREFERRED_TRIM_SIZE; i += 1) setKey(seed, `k${String(i)}`, i);
    for (const update of updates) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-a', update]);
    expect(await count('results-a')).toBe(PREFERRED_TRIM_SIZE);

    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc);
    await persistence.flush();
    expect(timers.pending()).toBe(0);
    expect(Object.keys(content(doc))).toHaveLength(PREFERRED_TRIM_SIZE);

    setKey(doc, 'one-more', 1);
    expect(timers.pending()).toBe(1);
  });
});

describe('SqlitePersistence: failures are surfaced', () => {
  it('reports a failed write, and recovers by storing the whole state later', async () => {
    const hurt = { on: true };
    const doc = new Y.Doc();
    const persistence = await opened('results-a', doc, faulty(db, { failRun: (sql) => hurt.on && sql.startsWith('INSERT') }));
    setKey(doc, 'lost-write', 1);
    await persistence.flush();
    expect(errors).toHaveLength(1);
    expect(await count('results-a')).toBe(0);
    expect(timers.pending()).toBe(1);

    hurt.on = false;
    timers.fireNext();
    await persistence.flush();
    const restored = new Y.Doc();
    await opened('results-a', restored);
    expect(content(restored)).toEqual({ 'lost-write': 1 });
  });

  it('rejects whenSynced and reports when the stored state cannot be read', async () => {
    const persistence = open(faulty(db, { failQuery: true }), 'results-a', new Y.Doc());
    await expect(persistence.whenSynced).rejects.toThrow('query failed');
    expect(errors).toHaveLength(1);
  });

  it('rejects whenSynced when a stored row is not a valid update, and keeps the rows', async () => {
    await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', ['results-a', Uint8Array.from([255, 255, 255, 255])]);
    const doc = new Y.Doc();
    const persistence = open(db, 'results-a', doc);
    await expect(persistence.whenSynced).rejects.toBeInstanceOf(Error);
    expect(errors).toHaveLength(1);
    expect(await count('results-a')).toBe(1);
  });
});
