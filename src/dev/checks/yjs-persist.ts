import * as Y from 'yjs';
import type { TimerPort } from '../../collab/timers';
import { COMPACTION_DEBOUNCE_MS, PREFERRED_TRIM_SIZE, SqlitePersistence, deleteDocRows } from '../../collab/y-sqlite';
import { fail, guarded, pass, type CheckDef } from './types';

const DOC = 'diag-yjs';
const EDITS = PREFERRED_TRIM_SIZE + 100;
/** The longest the check waits for the debounced compaction before it reports a failure. */
export const COMPACTION_WAIT_CEILING_MS = 10_000;
const MAX_ROWS_AFTER_COMPACTION = 2;

const def = { id: 'yjs-persist', title: '[diag] yjs-persist: Yjs persistence, compaction and reload on SQLite' };

export const yjsPersist: CheckDef = {
  ...def,
  hint: `Applies ${String(EDITS)} edits, waits for the real debounced compaction (about ${String(COMPACTION_DEBOUNCE_MS / 1000)} s), reloads a fresh document and compares.`,
  run: (ctx) =>
    guarded(def, async () => {
      const { db } = ctx.services;
      const { timers: real } = ctx.deps.ports;
      const started = ctx.services.clock.now();
      const errors: unknown[] = [];
      const open: SqlitePersistence[] = [];

      let signalFired: () => void = () => undefined;
      const fired = new Promise<'fired'>((resolve) => {
        signalFired = () => resolve('fired');
      });
      // The persistence arms its compaction through this port; the wrapper announces the moment it runs.
      const timers: TimerPort = {
        setTimeout: (callback, ms) =>
          real.setTimeout(() => {
            callback();
            signalFired();
          }, ms),
        clearTimeout: (handle) => {
          real.clearTimeout(handle);
        },
      };
      const onError = (error: unknown): void => {
        errors.push(error);
      };

      try {
        await deleteDocRows(db, DOC);
        const doc = new Y.Doc();
        const persistence = new SqlitePersistence(db, DOC, doc, { onError, timers });
        open.push(persistence);
        await persistence.whenSynced;
        const list = doc.getArray<number>('values');
        for (let i = 0; i < EDITS; i += 1) list.push([i]);

        let ceiling: unknown = null;
        const timedOut = new Promise<'timeout'>((resolve) => {
          ceiling = real.setTimeout(() => resolve('timeout'), COMPACTION_WAIT_CEILING_MS);
        });
        const outcome = await Promise.race([fired, timedOut]);
        real.clearTimeout(ceiling);
        if (outcome === 'timeout') return fail(def, `compaction=not_run_within_ms=${String(COMPACTION_WAIT_CEILING_MS)} edits=${String(EDITS)}`);
        await persistence.flush();

        const counted = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [DOC]);
        const rows = Number(counted[0]?.n);
        if (!(rows <= MAX_ROWS_AFTER_COMPACTION)) return fail(def, `rows_after_compaction=${String(rows)} limit=${String(MAX_ROWS_AFTER_COMPACTION)} edits=${String(EDITS)}`);
        await persistence.destroy();

        const reloaded = new Y.Doc();
        const second = new SqlitePersistence(db, DOC, reloaded, { onError });
        open.push(second);
        await second.whenSynced;
        const values = reloaded.getArray<number>('values').toJSON();
        const same = values.length === EDITS && values.every((value, index) => value === index);
        if (!same) return fail(def, `reload=different length=${String(values.length)} expected=${String(EDITS)} rows=${String(rows)}`);

        await second.clearData();
        const left = Number((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [DOC]))[0]?.n);
        if (left !== 0) return fail(def, `clear_data rows_left=${String(left)}`);
        if (errors.length > 0) return fail(def, `storage_errors=${String(errors.length)} edits=${String(EDITS)}`);
        return pass(def, `edits=${String(EDITS)} rows_after_compaction=${String(rows)} reload=identical cleared=yes ms=${String(ctx.services.clock.now() - started)}`);
      } finally {
        for (const instance of open) await instance.destroy().catch(() => undefined);
        await deleteDocRows(db, DOC).catch(() => undefined);
      }
    }),
};
