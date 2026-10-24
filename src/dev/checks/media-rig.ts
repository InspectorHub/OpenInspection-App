import { evaluateLock } from '../../offline/lock';
import { loadLockState } from '../../offline/lock-state';
import { createNativeUploader, type NativeUploader } from '../../media/native-uploader';
import { createMediaReconciler, type MediaReconciler } from '../../media/reconcile';
import { createMediaStore, type MediaRow, type MediaStore } from '../../media/store';
import type { UploaderPluginLike } from '../../platform/uploader';
import type { MediaState } from '../../platform/schema';
import type { DiagContext } from './types';

/** Every pending id the diagnostics create starts with this, so they can only ever touch their own rows. */
export const DIAG_PREFIX = 'diag-';

const STATES: readonly MediaState[] = ['pending', 'uploading', 'uploaded', 'failed'];

export interface Observed {
  /** Native uploads started. */
  starts: number;
  /** Terminal events the plugin delivered: the name and the HTTP status only. */
  events: { name: string; statusCode: number | null }[];
  /** States written to rows, in order. */
  states: MediaState[];
  errors: number;
}

export interface MediaRig {
  store: MediaStore;
  uploader: NativeUploader;
  reconciler: MediaReconciler;
  observed: Observed;
  dispose(): Promise<void>;
}

const isDiag = (row: MediaRow): boolean => row.pendingId.startsWith(DIAG_PREFIX);

/** The store as the reconciler sees it: only diagnostic rows are listed, so real photos are never uploaded by this screen. */
export function diagOnly(store: MediaStore): MediaStore {
  return {
    ...store,
    listRows: async (filter) => (await store.listRows(filter)).filter(isDiag),
    listRowsPage: async (filter) => {
      const page = await store.listRowsPage(filter);
      return { ...page, rows: page.rows.filter(isDiag) };
    },
  };
}

export function createDiagStore(ctx: DiagContext): MediaStore {
  return createMediaStore({ db: ctx.services.db, files: ctx.services.files });
}

export async function diagCounts(store: MediaStore): Promise<Record<MediaState, number> & { total: number }> {
  const rows = await store.listRows({ states: STATES });
  const counts = { pending: 0, uploading: 0, uploaded: 0, failed: 0, total: 0 };
  for (const row of rows) {
    if (!isDiag(row)) continue;
    counts[row.state] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Deletes every diagnostic row and its file; returns how many rows were there. */
export async function removeAllDiagMedia(store: MediaStore): Promise<number> {
  const rows = (await store.listRows({ states: STATES })).filter(isDiag);
  for (const row of rows) await store.delete(row.pendingId);
  return rows.length;
}

/** The real uploader and reconciler over the real store, with a document step that always reports `resolved`. */
export function buildRig(ctx: DiagContext, options: { concurrency: number }): MediaRig {
  const { services, deps } = ctx;
  const origin = ctx.origin;
  if (origin === null) throw new Error('A signed-in origin is required');
  const observed: Observed = { starts: 0, events: [], states: [], errors: 0 };
  const base = createDiagStore(ctx);
  const store: MediaStore = diagOnly({
    ...base,
    markState: (pendingId, state, patch) => {
      observed.states.push(state);
      return base.markState(pendingId, state, patch);
    },
  });
  const real = deps.uploaderPlugin;
  const plugin: UploaderPluginLike = {
    startUpload: (startOptions) => {
      observed.starts += 1;
      return real.startUpload(startOptions);
    },
    removeUpload: (removeOptions) => real.removeUpload(removeOptions),
    acknowledgeEvent: (ackOptions) => real.acknowledgeEvent(ackOptions),
    addListener: (name, listener) =>
      real.addListener(name, (event) => {
        if (event.name === 'completed' || event.name === 'failed') observed.events.push({ name: event.name, statusCode: event.payload?.statusCode ?? null });
        listener(event);
      }),
  };
  // Read-only: the rig must not move the stored latest time seen, so it evaluates without persisting.
  const isLocked = async (): Promise<boolean> => evaluateLock(await loadLockState(services.db), services.clock.now()).locked;
  const onError = (): void => {
    observed.errors += 1;
  };
  const uploader = createNativeUploader({
    store,
    http: services.http,
    tokens: services.tokens,
    plugin,
    origin,
    allowInsecureHttp: true,
    isLocked,
    clientHeaders: { 'X-Client-Platform': services.platform, 'X-Client-Version': services.appVersion },
    clock: services.clock,
    onError,
  });
  const reconciler = createMediaReconciler({
    store,
    uploader,
    resolvePending: () => Promise.resolve('resolved'),
    isLocked,
    network: deps.network,
    clock: services.clock,
    concurrency: options.concurrency,
    onError,
  });
  return {
    store,
    uploader,
    reconciler,
    observed,
    dispose: async () => {
      reconciler.stop();
      await uploader.dispose();
    },
  };
}
