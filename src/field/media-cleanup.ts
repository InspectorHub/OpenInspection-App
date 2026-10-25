import * as Y from 'yjs';
import type { CollabConnector, ResultsDocHandle } from '@inspectorhub/field-ui';
import type { MediaStore } from '../media/store';
import { pendingIdsInDoc } from './doc-photos';

/**
 * When the editor removes a photo from an inspection it does not touch the device store: the row and the file of a
 * photo that was only on this device would stay for ever. This watches the live results document and removes the row
 * of a `pendingId` that WAS in the document and is not any more.
 *
 * Only that rule is safe:
 *  - a row that was never in the document is left alone. The editor writes the row BEFORE it appends the entry, so
 *    "a row with no entry" is the normal state of a photo that is just being added;
 *  - a row that is `uploading` or `uploaded` is left alone. An entry also leaves the document when its upload finished
 *    and the editor swapped it to the real key; that row is the editor's (or the reconciler's) to delete, after the swap;
 *  - the removal is deferred past the end of the transaction that made it. The document's own storage writes its update
 *    when that transaction ends, and the database runs statements in call order, so the swap that made an entry leave
 *    the document is queued before this row delete.
 *
 * A document that is REPLACED (a version restore swaps in a new, still empty one) is never a reason to delete anything:
 * what the old one held has not "disappeared", the new one is just not populated yet. The seen set is rebuilt from the
 * new document and only removals seen on it from then on delete. The safe direction is to keep a row; the reconciler
 * treats an entry that is not in the document as "missing" and keeps the file.
 */

export interface CleanupDeps {
  /** The inspection this document belongs to: a row of any other inspection is never deleted. */
  inspectionId: string;
  store: Pick<MediaStore, 'deleteIfUnsent'>;
  /** A removal that failed. The row stays and the next removal of the same id is not retried; the file sweep finds it. */
  onError?(error: unknown): void;
}

export interface RemovedPhotoWatcher {
  /** Looks at `doc` from now on. Nothing is deleted because of the swap itself: see the note above. */
  follow(doc: Y.Doc): void;
  /** Resolves when every removal started so far has finished. */
  settled(): Promise<void>;
  stop(): void;
}

export function watchRemovedPhotos(initial: Y.Doc, deps: CleanupDeps): RemovedPhotoWatcher {
  let doc = initial;
  let stopped = false;
  const seen = new Set<string>();
  const jobs = new Set<Promise<void>>();

  async function remove(pendingId: string): Promise<void> {
    // Past the end of the transaction that removed the entry: the document's own storage writes its update when that
    // transaction ends, and the database runs statements in call order, so a swap is queued before this delete.
    await Promise.resolve();
    try {
      // One guarded statement: only a row still unsent, of this inspection, is removed.
      await deps.store.deleteIfUnsent(pendingId, deps.inspectionId);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  function reconcile(): void {
    const present = pendingIdsInDoc(doc);
    for (const id of present) seen.add(id);
    for (const id of [...seen]) {
      if (present.has(id)) continue;
      seen.delete(id);
      const job = remove(id);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    }
  }

  const relevant = (event: Y.YEvent<Y.AbstractType<unknown>>): boolean =>
    event.target instanceof Y.Array || event.path.length <= 1 || (event instanceof Y.YMapEvent && event.keysChanged.has('pendingId'));

  // A photo list changing, an item being added, replaced or removed, or an entry losing its pending id in place (a crop
  // or an annotation is resolved by editing its entry, not by replacing it). A keystroke in a note is none of these.
  const onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    if (events.some(relevant)) reconcile();
  };

  function attach(): void {
    seen.clear();
    for (const id of pendingIdsInDoc(doc)) seen.add(id);
    doc.getMap('results').observeDeep(onChange);
  }
  attach();

  return {
    follow: (next) => {
      if (next === doc) return;
      doc.getMap('results').unobserveDeep(onChange);
      doc = next;
      attach();
    },
    settled: async () => {
      while (jobs.size > 0) await Promise.allSettled([...jobs]);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      doc.getMap('results').unobserveDeep(onChange);
    },
  };
}

/** Wraps a connector so every document it opens is watched for removed photos until its handle is destroyed. */
export function withMediaCleanup(inner: CollabConnector, deps: Omit<CleanupDeps, 'inspectionId'>): CollabConnector {
  return {
    connect: (inspectionId, opts) => {
      const real = inner.connect(inspectionId, opts);
      const watcher = watchRemovedPhotos(real.doc, { ...deps, inspectionId });
      let destroyed = false;
      const handle: ResultsDocHandle = {
        get doc() {
          const current = real.doc;
          if (!destroyed) watcher.follow(current);
          return current;
        },
        get persistenceSynced() {
          return real.persistenceSynced;
        },
        synced: () => real.synced(),
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          watcher.stop();
          real.destroy();
        },
      };
      return handle;
    },
    purge: (inspectionId) => inner.purge(inspectionId),
  };
}
