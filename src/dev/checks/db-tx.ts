import type { Db } from '../../platform/db';
import { fail, guarded, pass, type CheckDef } from './types';

const DOC = 'diag-tx';
const MAX_KEY = 'diag_max';

const def = { id: 'db-tx', title: '[diag] db-tx: transactions, queueing and the MAX upsert on the real SQLite dialect' };

const INSERT = 'INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)';
const UPSERT_MAX =
  `INSERT INTO device_state (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`;

async function countRows(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [DOC]);
  return Number(rows[0]?.n);
}

async function rejects(work: Promise<unknown>): Promise<boolean> {
  try {
    await work;
    return false;
  } catch {
    return true;
  }
}

async function cleanup(db: Db): Promise<void> {
  await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [DOC]).catch(() => undefined);
  await db.run('DELETE FROM device_state WHERE key = ?', [MAX_KEY]).catch(() => undefined);
}

export const dbTx: CheckDef = {
  ...def,
  hint: 'Rollback after a throw, a failing nested transaction, queued calls during a transaction, and the MAX upsert with text values.',
  run: (ctx) =>
    guarded(def, async () => {
      const { db } = ctx.services;
      const started = ctx.services.clock.now();
      await cleanup(db);
      try {
        // 1. A throw inside the callback rolls everything back.
        const threw = await rejects(
          db.transaction(async (tx) => {
            await tx.run(INSERT, [DOC, new Uint8Array([9])]);
            throw new Error('diag rollback');
          }),
        );
        const afterThrow = await countRows(db);
        if (!threw || afterThrow !== 0) return fail(def, `rollback threw=${String(threw)} rows_left=${String(afterThrow)}`);

        // 2. A failing nested transaction rolls the outer one back even when the callback caught the error.
        const outerRejected = await rejects(
          db.transaction(async (tx) => {
            await tx.run(INSERT, [DOC, new Uint8Array([8])]);
            try {
              await tx.transaction(() => Promise.reject(new Error('diag nested')));
            } catch {
              // Caught on purpose: the outer transaction must still be rollback-only.
            }
          }),
        );
        const afterNested = await countRows(db);
        if (!outerRejected || afterNested !== 0) return fail(def, `nested outer_rejected=${String(outerRejected)} rows_left=${String(afterNested)}`);

        // 3. Calls made on the outer Db while a transaction runs queue behind it and finish in order.
        const finished: string[] = [];
        let queued: Promise<unknown>[] = [];
        await db.transaction(async (tx) => {
          await tx.run(INSERT, [DOC, new Uint8Array([1])]);
          queued = [
            db.run(INSERT, [DOC, new Uint8Array([2])]).then(() => finished.push('a')),
            db.run(INSERT, [DOC, new Uint8Array([3])]).then(() => finished.push('b')),
          ];
          await tx.run(INSERT, [DOC, new Uint8Array([1])]);
          finished.push('tx');
        });
        await Promise.all(queued);
        const rows = await db.query<{ data: Uint8Array }>('SELECT data FROM ydoc_updates WHERE doc_name = ? ORDER BY id', [DOC]);
        const order = rows.map((row) => Number(row.data[0])).join('');
        if (finished.join(',') !== 'tx,a,b' || order !== '1123') return fail(def, `queue finished=${finished.join('>')} stored_order=${order}`);

        // 4. The MAX upsert compares as integers, not as text: '9' then '10' ends at '10'.
        await db.run(UPSERT_MAX, [MAX_KEY, '9']);
        await db.run(UPSERT_MAX, [MAX_KEY, '10']);
        const up = (await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [MAX_KEY]))[0]?.value;
        await db.run(UPSERT_MAX, [MAX_KEY, '9']);
        const down = (await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [MAX_KEY]))[0]?.value;
        if (up !== '10' || down !== '10') return fail(def, `max_upsert after_9_10=${String(up)} after_9_again=${String(down)}`);

        return pass(def, `rollback=ok nested=ok queue_order=ok max_upsert=ok ms=${String(ctx.services.clock.now() - started)}`);
      } finally {
        await cleanup(db);
      }
    }),
};
