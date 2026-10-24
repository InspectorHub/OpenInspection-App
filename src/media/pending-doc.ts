import * as Y from 'yjs';
import { resultsDocName } from '../collab/connector';
import { realTimers, type TimerPort } from '../collab/timers';
import { SqlitePersistence } from '../collab/y-sqlite';
import type { Db } from '../platform/db';
import { isValidMediaId, MediaError } from './errors';
import { isValidUploadedKey } from './store';

/**
 * `resolved`: the pending entry now carries the official key. `already`: an entry with that key is there and
 * no pending entry is. `missing`: neither exists in the document (the entry may not have been written yet, or
 * was removed); the caller keeps the local file.
 */
export type ResolveResult = 'resolved' | 'already' | 'missing';

/** Pending fields the editor puts on a photo entry while its bytes are only on the device. */
const PENDING_FIELDS = ['pendingUpload', 'pendingId', 'pendingKind'] as const;

function photoArrays(doc: Y.Doc): Y.Array<unknown>[] {
  const arrays: Y.Array<unknown>[] = [];
  doc.getMap<unknown>('results').forEach((item) => {
    if (!(item instanceof Y.Map)) return;
    const photos = item.get('photos');
    if (photos instanceof Y.Array) arrays.push(photos);
  });
  return arrays;
}

/**
 * Swaps the pending entry of a new offline photo for its official key, in place.
 *
 * This mirrors `resolvePendingPhoto(doc, findingKey, pendingId, 'photo', undefined, { key })` of the editor
 * package for a new photo: the entry is found by its `pendingId`, rebuilt without the pending fields and with
 * `key` set, and put back at the same position inside one transaction. `@inspectorhub/field-ui` 0.2.1 does
 * not export that function, so the document shape is mirrored here; replace this with the package export when
 * it ships. The entry is found without a finding key, by scanning every item's photos, which keeps the
 * resolution independent of the `meta` stored with the row.
 */
export function resolvePendingInDoc(doc: Y.Doc, pendingId: string, uploadedKey: string): ResolveResult {
  let result: ResolveResult = 'missing';
  doc.transact(() => {
    for (const photos of photoArrays(doc)) {
      for (let i = 0; i < photos.length; i += 1) {
        const entry = photos.get(i);
        if (!(entry instanceof Y.Map)) continue;
        if (entry.get('pendingId') === pendingId && entry.get('pendingUpload') === true) {
          const fresh = new Y.Map<unknown>();
          for (const [field, value] of Object.entries(entry.toJSON() as Record<string, unknown>)) {
            if ((PENDING_FIELDS as readonly string[]).includes(field) || value === undefined) continue;
            fresh.set(field, value);
          }
          fresh.set('key', uploadedKey);
          photos.delete(i, 1);
          photos.insert(i, [fresh]);
          result = 'resolved';
          return;
        }
      }
    }
    if (photoArrays(doc).some((photos) => photos.toArray().some((entry) => entry instanceof Y.Map && entry.get('key') === uploadedKey && entry.get('pendingId') === undefined))) {
      result = 'already';
    }
  });
  return result;
}

/** Runs `fn` against the results document of an inspection and settles once its changes are stored. */
export type WithDoc = <T>(inspectionId: string, fn: (doc: Y.Doc) => T) => Promise<T>;

/** What the collab connector can say about the document of an inspection. */
export interface DocPorts {
  /** True while the connector holds a connection for the inspection (`NativeCollabConnector.isOpen`). */
  isOpen(inspectionId: string): boolean;
  /** The live document of that connection, or null when the host cannot hand it out. */
  liveDoc(inspectionId: string): Y.Doc | null;
}

export interface WithDocDeps {
  db: Db;
  docs: DocPorts;
  timers?: TimerPort;
  /** Receives storage failures of the short-lived persistence. */
  onError?: (error: unknown) => void;
}

/** True when everything `doc` holds (structs and deletions) is also in the stored updates of `docName`. */
async function storedStateMatches(deps: WithDocDeps, timers: TimerPort, docName: string, doc: Y.Doc): Promise<boolean> {
  const scratch = new Y.Doc();
  let readFailed = false;
  const reader = new SqlitePersistence(deps.db, docName, scratch, {
    timers,
    onError: (error) => {
      readFailed = true;
      deps.onError?.(error);
    },
  });
  try {
    await reader.whenSynced;
    return !readFailed && Y.equalSnapshots(Y.snapshot(doc), Y.snapshot(scratch));
  } finally {
    await reader.destroy().catch(() => undefined);
    scratch.destroy();
  }
}

/**
 * The live document when the editor has the inspection open (its own persistence stores the change and its
 * connection syncs it). Otherwise a short-lived document over the same stored updates: loaded, changed,
 * flushed, checked against the table and destroyed, so the change is in the table the next time the inspection
 * opens. It is NEVER opened next to a live connection: when the connector reports one open but its document is
 * not available, this fails with DOC_BUSY and the caller tries again later.
 *
 * The live path does not wait for the editor's persistence: the editor writes through the same `Db`, whose
 * queue runs statements in call order, so a later write of the editor cannot overtake this change, and a failed
 * write there is reported by the editor's own persistence and repaired by its compaction.
 *
 * On the short-lived path a change counts as stored only when no storage error was reported while it was
 * written AND a fresh document read back from the table equals the changed one. Anything else throws
 * DOC_FAILED, so the caller keeps the local file and its row and retries only the resolve.
 */
export function createWithDoc(deps: WithDocDeps): WithDoc {
  const timers = deps.timers ?? realTimers;
  return async <T>(inspectionId: string, fn: (doc: Y.Doc) => T): Promise<T> => {
    if (!isValidMediaId(inspectionId)) throw new MediaError('INVALID_ID');
    if (deps.docs.isOpen(inspectionId)) {
      const live = deps.docs.liveDoc(inspectionId);
      if (live === null) throw new MediaError('DOC_BUSY');
      return fn(live);
    }
    const docName = resultsDocName(inspectionId);
    const doc = new Y.Doc();
    let storageFailed = false;
    const persistence = new SqlitePersistence(deps.db, docName, doc, {
      timers,
      onError: (error) => {
        storageFailed = true;
        deps.onError?.(error);
      },
    });
    try {
      await persistence.whenSynced;
      let changed = false;
      const markChanged = (): void => {
        changed = true;
      };
      doc.on('update', markChanged);
      const out = fn(doc);
      doc.off('update', markChanged);
      await persistence.flush();
      if (storageFailed) throw new MediaError('DOC_FAILED');
      if (changed && !(await storedStateMatches(deps, timers, docName, doc))) throw new MediaError('DOC_FAILED');
      return out;
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('DOC_FAILED');
    } finally {
      await persistence.destroy().catch(() => undefined);
      doc.destroy();
    }
  };
}

export interface PendingResolverDeps {
  withDoc: WithDoc;
}

/** `resolvePending(inspectionId, pendingId, uploadedKey)` for the reconciler, over a `WithDoc`. */
export function createPendingResolver(deps: PendingResolverDeps): (inspectionId: string, pendingId: string, uploadedKey: string) => Promise<ResolveResult> {
  return (inspectionId, pendingId, uploadedKey) => {
    if (!isValidMediaId(inspectionId) || !isValidMediaId(pendingId)) return Promise.reject(new MediaError('INVALID_ID'));
    if (!isValidUploadedKey(uploadedKey)) return Promise.reject(new MediaError('INVALID_RECORD'));
    return deps.withDoc(inspectionId, (doc) => resolvePendingInDoc(doc, pendingId, uploadedKey));
  };
}
