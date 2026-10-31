import { describe, expect, it } from 'vitest';
import type { Db } from '../db';

/** The same observable database contract runs against every concrete adapter. */
export function describeDbContract(name: string, make: () => Promise<Db>): void {
  describe(`${name} Db contract`, () => {
    it('rolls back a transaction when its callback throws', async () => {
      const db = await make();
      await db.execute('CREATE TABLE contract_rollback (value TEXT NOT NULL)');
      await expect(db.transaction(async (tx) => {
        await tx.run('INSERT INTO contract_rollback (value) VALUES (?)', ['hidden']);
        throw new Error('fail');
      })).rejects.toThrow('fail');
      await expect(db.query('SELECT value FROM contract_rollback')).resolves.toEqual([]);
    });

    it('marks a nested transaction rollback-only even when the outer callback catches it', async () => {
      const db = await make();
      await db.execute('CREATE TABLE contract_nested (value TEXT NOT NULL)');
      await expect(db.transaction(async (tx) => {
        await tx.run('INSERT INTO contract_nested (value) VALUES (?)', ['outer']);
        try {
          await tx.transaction(async (nested) => {
            await nested.run('INSERT INTO contract_nested (value) VALUES (?)', ['nested']);
            throw new Error('nested failure');
          });
        } catch { /* The outer transaction still must roll back. */ }
      })).rejects.toThrow('nested transaction failed');
      await expect(db.query('SELECT value FROM contract_nested')).resolves.toEqual([]);
    });

    it('reads and writes PRAGMA user_version', async () => {
      const db = await make();
      await db.execute('PRAGMA user_version = 17');
      await expect(db.query<{ user_version: number }>('PRAGMA user_version')).resolves.toEqual([{ user_version: 17 }]);
    });

    it('preserves invocation ordering through the queue', async () => {
      const db = await make();
      await db.execute('CREATE TABLE contract_order (value INTEGER NOT NULL)');
      const first = db.run('INSERT INTO contract_order (value) VALUES (?)', [1]);
      const second = db.query<{ value: number }>('SELECT value FROM contract_order ORDER BY value');
      await expect(first).resolves.toMatchObject({ changes: 1 });
      await expect(second).resolves.toEqual([{ value: 1 }]);
    });

    it('round-trips a byte-perfect 1 MiB BLOB as a fresh Uint8Array', async () => {
      const db = await make();
      await db.execute('CREATE TABLE contract_blob (value BLOB NOT NULL)');
      const original = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 31 + 7) & 0xff);
      await db.run('INSERT INTO contract_blob (value) VALUES (?)', [original]);
      const rows = await db.query<{ value: unknown }>('SELECT value FROM contract_blob');
      const value = rows[0]?.value;
      expect(value).toBeInstanceOf(Uint8Array);
      expect(value).not.toBe(original);
      expect(value).toEqual(original);
    });
  });
}
