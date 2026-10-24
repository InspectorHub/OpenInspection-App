import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { createSqlJsDb } from './db-sqljs';

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await db.execute('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, data BLOB)');
});

describe('Db (sql.js test double)', () => {
  it('creates tables and inserts with bound parameters', async () => {
    const res = await db.run('INSERT INTO items (name) VALUES (?)', ['first']);
    expect(res.changes).toBe(1);
    expect(res.lastId).toBe(1);
    const rows = await db.query<{ id: number; name: string }>('SELECT id, name FROM items WHERE name = ?', ['first']);
    expect(rows).toEqual([{ id: 1, name: 'first' }]);
  });

  it('treats parameters as data, not SQL', async () => {
    await db.run('INSERT INTO items (name) VALUES (?)', ["x'); DROP TABLE items; --"]);
    const rows = await db.query<{ name: string }>('SELECT name FROM items');
    expect(rows).toEqual([{ name: "x'); DROP TABLE items; --" }]);
  });

  it('returns an empty array when nothing matches', async () => {
    expect(await db.query('SELECT * FROM items')).toEqual([]);
  });

  it('commits a transaction that resolves', async () => {
    const out = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (name) VALUES (?)', ['a']);
      await tx.run('INSERT INTO items (name) VALUES (?)', ['b']);
      return 'done';
    });
    expect(out).toBe('done');
    expect(await db.query('SELECT name FROM items ORDER BY id')).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('leaves no residue after a throw inside a transaction', async () => {
    await db.run('INSERT INTO items (name) VALUES (?)', ['kept']);
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['lost']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT name FROM items')).toEqual([{ name: 'kept' }]);
  });

  it('rolls back when a statement inside the transaction fails', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['lost']);
        await tx.run('INSERT INTO items (name) VALUES (?)', [null]);
      }),
    ).rejects.toThrow();
    expect(await db.query('SELECT name FROM items')).toEqual([]);
  });

  it('stays usable after a rolled-back transaction', async () => {
    await expect(db.transaction(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await db.run('INSERT INTO items (name) VALUES (?)', ['after']);
    expect(await db.query('SELECT name FROM items')).toEqual([{ name: 'after' }]);
  });

  it('round-trips a BLOB byte for byte', async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    await db.run('INSERT INTO items (name, data) VALUES (?, ?)', ['blob', bytes]);
    const rows = await db.query<{ data: Uint8Array }>('SELECT data FROM items WHERE name = ?', ['blob']);
    const got = rows[0]?.data;
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got ?? [])).toEqual(Array.from(bytes));
  });

  it('allows helpers to share the transaction handle', async () => {
    const insert = (d: Db, name: string) => d.run('INSERT INTO items (name) VALUES (?)', [name]);
    await expect(
      db.transaction(async (tx) => {
        await insert(tx, 'one');
        await tx.transaction(async (inner) => {
          await insert(inner, 'two');
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await db.query('SELECT * FROM items')).toEqual([]);

    await db.transaction(async (tx) => {
      await insert(tx, 'one');
      await tx.transaction(async (inner) => {
        await insert(inner, 'two');
      });
    });
    expect(await db.query('SELECT name FROM items ORDER BY id')).toEqual([{ name: 'one' }, { name: 'two' }]);
  });

  it('serialises concurrent top-level transactions', async () => {
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['t1']);
        await Promise.resolve();
        await tx.run('INSERT INTO items (name) VALUES (?)', ['t1b']);
      }),
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['t2']);
      }),
    ]);
    expect(await db.query('SELECT name FROM items ORDER BY id')).toEqual([
      { name: 't1' },
      { name: 't1b' },
      { name: 't2' },
    ]);
  });
});
