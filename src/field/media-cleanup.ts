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
 * A removal that is undone later (a version restore bringing an old entry back) finds no row to send; the person adds
 * the photo again.
 */

export interface CleanupDeps {
  store: Pick<MediaStore, 'getRow' | 'delete'>;
  /** A removal that failed. The row stays and the next removal of the same id is not retried; the file sweep finds it. */
  onError?(error: unknown): void;
}

export interface RemovedPhotoWatcher {
  /** Looks at `doc` from now on. A version restore replaces the document, and what the old one held is compared with the new one. */
  follow(doc: Y.Doc): void;
  /** Resolves when every removal started so far has finished. */
  settled(): Promise<void>;
  stop(): void;
}

/** The states in which a row is still only a local copy nobody is sending. */
const REMOVABLE_STATES: readonly string[] = ['pending', 'failed'];

export function watchRemovedPhotos(initial: Y.Doc, deps: CleanupDeps): RemovedPhotoWatcher {
  let doc = initial;
  let stopped = false;
  const seen = new Set<string>();
  const jobs = new Set<Promise<void>>();

  async function remove(pendingId: string): Promise<void> {
    // Past the end of the transaction that removed the entry: see the note above.
    await Promise.resolve();
    try {
      const row = await deps.store.getRow(pendingId);
      if (row !== null && REMOVABLE_STATES.includes(row.state)) await deps.store.delete(pendingId);
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

  const onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    // A photo list changing, an item being added, replaced or removed, or an entry losing its pending id in place (a crop
    // or an annotation is resolved by editing its entry, not by replacing it). A keystroke in a note is none of these.
    const relevant = (event: Y.YEvent<Y.AbstractType<unknown>>): boolean =>
      event.target instanceof Y.Array || event.path.length <= 1 || (event instanceof Y.YMapEvent && event.keysChanged.has('pendingId'));
    if (!stopped && events.some(relevant)) reconcile();
  };

  doc.getMap('results').observeDeep(onChange);
  reconcile();

  return {
    follow: (next) => {
      if (stopped || next === doc) return;
      doc.getMap('results').unobserveDeep(onChange);
      doc = next;
      doc.getMap('results').observeDeep(onChange);
      reconcile();
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
export function withMediaCleanup(inner: CollabConnector, deps: CleanupDeps): CollabConnector {
  return {
    connect: (inspectionId, opts) => {
      const real = inner.connect(inspectionId, opts);
      const watcher = watchRemovedPhotos(real.doc, deps);
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
