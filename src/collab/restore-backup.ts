import * as Y from 'yjs';
import type { Db } from '../platform/db';
import { isValidDocName } from './y-sqlite';

/**
 * The copy of an inspection's document that a version restore set aside instead of merging.
 *
 * A restore cannot be applied additively (Yjs updates only add, so the reverted findings would survive a merge), so
 * `handleRestore` drops the local document and re-pulls the restored state. Before it drops anything it saves the
 * whole state of the discarded document here, in ONE slot per inspection: the next restore overwrites the slot, so a
 * copy the person never looked at does not pile up. The row is the notice as well as the recovery: while it exists,
 * the editor shows the restore notice with a one-tap path to put the copy back. A purge of the inspection and a
 * clear of local data delete the row with the rest of the inspection's data.
 *
 * The backup is a full Yjs state update, not a list of edits: applying it to the live document (`restoreBackup` in
 * the stack) merges the set-aside findings back in, including the pending photo entries the restore deleted, so the
 * media reconciler can attach the uploaded photos afterwards.
 */

/** Why the copy was set aside. Only a version restore writes one today. */
export const RESTORE_BACKUP_REASON = 'restore' as const;
export type RestoreBackupReason = typeof RESTORE_BACKUP_REASON;

export interface RestoreBackup {
  /** The `results-<inspection id>` document name this copy belongs to. */
  docName: string;
  /** The full state of the discarded document, as one Yjs update. */
  data: Uint8Array;
  /** Epoch ms of the restore that set it aside. */
  createdAt: number;
  reason: RestoreBackupReason;
}

/** `Y.encodeStateAsUpdate` of a document with no structs and no deletions: two zero counts. */
const EMPTY_UPDATE_BYTES = 2;

interface RestoreBackupRow {
  doc_name: string;
  data: unknown;
  created_at: number;
  reason: string;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error('A stored restore backup is not binary');
}

function toBackup(row: RestoreBackupRow): RestoreBackup {
  return {
    docName: row.doc_name,
    data: toBytes(row.data),
    createdAt: Number(row.created_at),
    reason: RESTORE_BACKUP_REASON,
  };
}

/**
 * The full state of `doc` as one update, or null when the document holds nothing: an empty document has nothing worth
 * a backup, and a restore of one needs no notice.
 */
export function backupStateOf(doc: Y.Doc): Uint8Array | null {
  const state = Y.encodeStateAsUpdate(doc);
  return state.byteLength > EMPTY_UPDATE_BYTES ? state : null;
}

/** Saves `update` as the inspection's one backup slot, replacing any copy an earlier restore left. */
export async function saveRestoreBackup(db: Db, docName: string, update: Uint8Array, createdAt: number): Promise<void> {
  if (!isValidDocName(docName)) throw new RangeError('Invalid document name');
  await db.run('INSERT OR REPLACE INTO restore_backups (doc_name, data, created_at, reason) VALUES (?, ?, ?, ?)', [
    docName,
    update,
    createdAt,
    RESTORE_BACKUP_REASON,
  ]);
}

/** The inspection's saved copy, or null when no restore has set one aside (or it was restored or discarded). */
export async function readRestoreBackup(db: Db, docName: string): Promise<RestoreBackup | null> {
  if (!isValidDocName(docName)) throw new RangeError('Invalid document name');
  const rows = await db.query<RestoreBackupRow>('SELECT doc_name, data, created_at, reason FROM restore_backups WHERE doc_name = ?', [docName]);
  const row = rows[0];
  return row === undefined ? null : toBackup(row);
}

/** Every saved copy, oldest first. The stack reads these at start so a notice survives an app restart. */
export async function listRestoreBackups(db: Db): Promise<RestoreBackup[]> {
  const rows = await db.query<RestoreBackupRow>('SELECT doc_name, data, created_at, reason FROM restore_backups ORDER BY created_at, doc_name');
  return rows.map(toBackup);
}

/** Deletes the inspection's saved copy, if any. A purge and a clear of local data delete it the same way. */
export async function deleteRestoreBackup(db: Db, docName: string): Promise<void> {
  if (!isValidDocName(docName)) throw new RangeError('Invalid document name');
  await db.run('DELETE FROM restore_backups WHERE doc_name = ?', [docName]);
}
