/*
 * Yjs persistence over the app's SQLite database.
 *
 * Ported from y-indexeddb 9.0.12 (https://github.com/yjs/y-indexeddb), whose logic this follows:
 *   MIT License. Copyright (c) 2014 Kevin Jahns <kevin.jahns@protonmail.com>.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction,
 *   including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 *
 * What differs from the original, on purpose:
 *   - Storage is the `ydoc_updates` table (one row per Yjs update, keyed by `doc_name`), reached
 *     through the `Db` port, so every statement is bound by parameter and no name is ever pattern-matched.
 *   - An empty document writes nothing when it is opened.
 *   - Write failures are reported through `onError` instead of being dropped, and a failed write schedules
 *     a compaction, which stores the whole state and so repairs the gap.
 *   - Compaction is one short transaction, and it takes its snapshot inside that transaction, so an edit
 *     made while it waits for the connection is either in the snapshot or stored after it.
 */
import * as Y from 'yjs';
import type { Db } from '../platform/db';
import { realTimers, type TimerPort } from './timers';

/** Updates stored for one document before a compaction is scheduled. */
export const PREFERRED_TRIM_SIZE = 500;
/** How long the edits must stay quiet before the compaction runs. */
export const COMPACTION_DEBOUNCE_MS = 1000;
/** Rows read per query on load, so no single query result grows with the document. */
const LOAD_PAGE_SIZE = 100;
/** `Y.encodeStateAsUpdate` of a document with no structs and no deletions: two zero counts. */
const EMPTY_UPDATE_BYTES = 2;
/** `results-` plus an inspection id of at most 64 characters. */
const DOC_NAME_PATTERN = /^[A-Za-z0-9_-]{1,72}$/;

/** True for a name made only of letters, digits, `_` and `-`, at most 72 characters. */
export function isValidDocName(name: string): boolean {
  return DOC_NAME_PATTERN.test(name);
}

/** Deletes every stored update of one document. The name is validated and bound, never matched as a pattern. */
export async function deleteDocRows(db: Db, docName: string): Promise<void> {
  if (!isValidDocName(docName)) throw new RangeError('Invalid document name');
  await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [docName]);
}

export interface SqlitePersistenceOptions {
  /**
   * Receives every storage failure: a write that failed, a compaction that rolled back, a read that failed.
   * The default rethrows it outside the call that caused it, so a failure is never silent.
   */
  onError?: (error: unknown) => void;
  /** Timers for the compaction debounce. */
  timers?: TimerPort;
}

/** The default `onError`: rethrows outside the call that failed, so a failure is never silent. */
export function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error instanceof Error ? error : new Error('Yjs persistence failed');
  });
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error('A stored Yjs update is not binary');
}

export class SqlitePersistence {
  /** Resolves once the stored state has been applied. Rejects if it cannot be read; never settles if destroyed first. */
  readonly whenSynced: Promise<this>;

  private readonly db: Db;
  private readonly docName: string;
  private readonly doc: Y.Doc;
  private readonly onError: (error: unknown) => void;
  private readonly timers: TimerPort;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly loading: Promise<boolean>;
  private readonly storeUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onDocDestroy: () => void;
  private destroyed = false;
  private ready = false;
  /** Rows this document has in the table, as far as this instance knows. */
  private size = 0;
  /** Inserts issued so far; a compaction uses it to count the rows queued behind it. */
  private issued = 0;
  private compactionTimer: unknown = null;

  constructor(db: Db, docName: string, doc: Y.Doc, options: SqlitePersistenceOptions = {}) {
    if (!isValidDocName(docName)) throw new RangeError('Invalid document name');
    this.db = db;
    this.docName = docName;
    this.doc = doc;
    this.onError = options.onError ?? rethrowLater;
    this.timers = options.timers ?? realTimers;

    // Registered before the first read so no edit is missed; edits made before the state is applied are
    // stored with it (see `load`), so they are ignored here.
    this.storeUpdate = (update, origin) => {
      if (this.destroyed || !this.ready || origin === this) return;
      this.insert(update);
      this.size += 1;
      if (this.size >= PREFERRED_TRIM_SIZE) this.scheduleCompaction();
    };
    this.onDocDestroy = () => {
      void this.destroy();
    };
    doc.on('update', this.storeUpdate);
    doc.on('destroy', this.onDocDestroy);

    this.loading = this.load();
    this.whenSynced = this.loading.then((applied) => (applied ? this : new Promise<never>(() => undefined)));
    // A failed read is reported through onError; this keeps it from also surfacing as an unhandled rejection
    // while still letting every caller of `whenSynced` see the rejection.
    this.whenSynced.catch(() => undefined);
  }

  /** Resolves when every write and compaction started so far has finished. */
  async flush(): Promise<void> {
    await this.loading.catch(() => undefined);
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Stops storing and waits for writes already started. The stored rows stay. Safe to call again. */
  async destroy(): Promise<void> {
    if (!this.destroyed) {
      this.destroyed = true;
      if (this.compactionTimer !== null) {
        this.timers.clearTimeout(this.compactionTimer);
        this.compactionTimer = null;
      }
      this.doc.off('update', this.storeUpdate);
      this.doc.off('destroy', this.onDocDestroy);
    }
    await this.flush();
  }

  /** Stops storing, then deletes every row of this document. */
  async clearData(): Promise<void> {
    await this.destroy();
    await deleteDocRows(this.db, this.docName);
  }

  private fail(error: unknown): void {
    this.onError(error);
  }

  private track(work: Promise<unknown>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
  }

  private insert(update: Uint8Array): void {
    this.issued += 1;
    this.track(
      this.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [this.docName, update]).then(
        () => undefined,
        (error: unknown) => {
          this.fail(error);
          // The edit is in the document but not in the table: a whole-state compaction stores it.
          this.scheduleCompaction();
        },
      ),
    );
  }

  /** Returns false when destroyed before the stored state was applied. */
  private async load(): Promise<boolean> {
    try {
      const stored: Uint8Array[] = [];
      let from = 0;
      for (;;) {
        const page = await this.db.query<{ id: number; data: unknown }>(
          'SELECT id, data FROM ydoc_updates WHERE doc_name = ? AND id >= ? ORDER BY id LIMIT ?',
          [this.docName, from, LOAD_PAGE_SIZE],
        );
        for (const row of page) stored.push(toBytes(row.data));
        const last = page[page.length - 1];
        if (page.length < LOAD_PAGE_SIZE || last === undefined) break;
        from = Number(last.id) + 1;
      }
      if (this.destroyed) return false;

      // Whatever the document already holds is not in the table yet; keep it, as the original does.
      const early = Y.encodeStateAsUpdate(this.doc);
      Y.transact(
        this.doc,
        () => {
          for (const update of stored) Y.applyUpdate(this.doc, update);
        },
        this,
        false,
      );
      this.size = stored.length;
      this.ready = true;
      if (early.byteLength > EMPTY_UPDATE_BYTES) {
        this.insert(early);
        this.size += 1;
      }
      return true;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private scheduleCompaction(): void {
    if (this.destroyed) return;
    if (this.compactionTimer !== null) this.timers.clearTimeout(this.compactionTimer);
    this.compactionTimer = this.timers.setTimeout(() => {
      this.compactionTimer = null;
      this.track(this.compact());
    }, COMPACTION_DEBOUNCE_MS);
  }

  /**
   * Replaces this document's rows with one row holding its whole state. One transaction: the new row goes in
   * first and everything older than it comes out, so a failure rolls back to the rows it started with.
   */
  private compact(): Promise<void> {
    return this.db
      .transaction(async (tx) => {
        // Taken inside the transaction: every insert issued before it has run, and an edit that is still
        // queued behind it is in the document, so it is in this snapshot as well as in its own later row.
        const mark = this.issued;
        const state = Y.encodeStateAsUpdate(this.doc);
        await tx.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [this.docName, state]);
        const newest = await tx.query<{ id: number }>('SELECT MAX(id) AS id FROM ydoc_updates WHERE doc_name = ?', [this.docName]);
        await tx.run('DELETE FROM ydoc_updates WHERE doc_name = ? AND id < ?', [this.docName, Number(newest[0]?.id)]);
        const remaining = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?', [this.docName]);
        return { rows: Number(remaining[0]?.n), mark };
      })
      .then(
        ({ rows, mark }) => {
          this.size = rows + (this.issued - mark);
        },
        (error: unknown) => {
          this.fail(error);
        },
      );
  }
}
