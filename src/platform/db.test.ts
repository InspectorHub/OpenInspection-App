import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('outer-db calls during an open transaction', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const names = async () =>
      (await db.query<{ name: string }>('SELECT name FROM items ORDER BY id')).map((r) => r.name);

    it('queues an unrelated caller and runs it after the commit', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const txn = db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['in-tx']);
        await gate;
      });
      await Promise.resolve();
      const other = db.run('INSERT INTO items (name) VALUES (?)', ['unrelated']);
      const seen = db.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      release();
      await txn;
      await other;
      expect((await seen).map((r) => r.name)).toEqual(['in-tx', 'unrelated']);
      expect(await names()).toEqual(['in-tx', 'unrelated']);
    });

    it('still runs a queued caller after the transaction rolls back', async () => {
      let fail: () => void = () => undefined;
      const gate = new Promise<void>((_, reject) => {
        fail = () => reject(new Error('boom'));
      });
      const txn = db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['lost']);
        await gate;
      });
      const caught = expect(txn).rejects.toThrow('boom');
      await Promise.resolve();
      const other = db.run('INSERT INTO items (name) VALUES (?)', ['unrelated']);
      fail();
      await caught;
      await other;
      expect(await names()).toEqual(['unrelated']);
    });

    it('rejects a re-entrant call after the deadlock timeout, and the transaction still commits', async () => {
      vi.useFakeTimers();
      const timed = await createSqlJsDb({ deadlockTimeoutMs: 1000 });
      await timed.execute('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
      let reentrantError: unknown;
      const txn = timed.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['a']);
        await timed.run('INSERT INTO items (name) VALUES (?)', ['ghost']).catch((e: unknown) => {
          reentrantError = e;
        });
        await tx.run('INSERT INTO items (name) VALUES (?)', ['b']);
        return 'ok';
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await txn).toBe('ok');
      expect(String((reentrantError as Error).message)).toMatch(
        /waited more than 1000 ms behind an open transaction.*use the tx handle/i,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const rows = await timed.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
    });

    it('lets the transaction roll back normally after a re-entrant call timed out', async () => {
      vi.useFakeTimers();
      const timed = await createSqlJsDb({ deadlockTimeoutMs: 1000 });
      await timed.execute('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
      const txn = timed.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['lost']);
        await timed.run('INSERT INTO items (name) VALUES (?)', ['ghost']);
      });
      const caught = expect(txn).rejects.toThrow(/waited more than 1000 ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await caught;
      await timed.run('INSERT INTO items (name) VALUES (?)', ['after']);
      const rows = await timed.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['after']);
    });

    it('does not time out queued callers behind a long but legitimate transaction', async () => {
      vi.useFakeTimers();
      const timed = await createSqlJsDb({ deadlockTimeoutMs: 1000 });
      await timed.execute('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
      const txn = timed.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['slow']);
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      await Promise.resolve();
      const other = timed.run('INSERT INTO items (name) VALUES (?)', ['waiter']);
      await vi.advanceTimersByTimeAsync(600);
      await txn;
      await other;
      await vi.advanceTimersByTimeAsync(5000);
      const rows = await timed.query<{ name: string }>('SELECT name FROM items ORDER BY id');
      expect(rows.map((r) => r.name)).toEqual(['slow', 'waiter']);
    });

    it('keeps calls through the tx handle working', async () => {
      const out = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['x']);
        return tx.query<{ name: string }>('SELECT name FROM items');
      });
      expect(out).toEqual([{ name: 'x' }]);
    });
  });

  it('positive control: the tx handle reads inside its own transaction', async () => {
    const out = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO items (name) VALUES (?)', ['in']);
      return tx.query('SELECT name FROM items');
    });
    expect(out).toEqual([{ name: 'in' }]);
  });

  it('commits nothing when a nested transaction failed and the outer swallowed it', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO items (name) VALUES (?)', ['outer']);
        await tx
          .transaction(async (inner) => {
            await inner.run('INSERT INTO items (name) VALUES (?)', ['inner']);
            throw new Error('inner failed');
          })
          .catch(() => undefined);
      }),
    ).rejects.toThrow(/nested transaction failed/i);
    expect(await db.query('SELECT * FROM items')).toEqual([]);
  });
});
