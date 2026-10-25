import type { Doc } from 'yjs';
import type { Http } from '../auth/http';
import { safeClientHeaders } from '../auth/client-headers';
import { loadIdentity, writeDeviceState, type StoredIdentity } from '../auth/server-config';
import type { TokenManager } from '../auth/tokens';
import { createCollabConnector, type CollabStatus, type NativeCollabConnector, type SocketFactory } from '../collab/connector';
import type { TimerPort } from '../collab/timers';
import { createNativeUploader, type NativeUploader } from '../media/native-uploader';
import { createWithDoc, createPendingResolver } from '../media/pending-doc';
import { createMediaReconciler, type MediaReconciler } from '../media/reconcile';
import { createMediaStore, type MediaStore } from '../media/store';
import { sweepOrphanFiles } from '../media/sweep';
import { sweepUploaderTempFiles } from '../media/uploader-temp';
import { createVideoStrategy, type ResolveVideo } from '../media/video';
import { createBlockedGuard } from '../offline/blocked';
import { evaluateLock } from '../offline/lock';
import { loadLockState } from '../offline/lock-state';
import type { AppStatePort } from '../offline/lock-monitor';
import { enqueue, OutboxError, type Account, type OutboxRow } from '../offline/outbox';
import { resumePurges } from '../offline/purge';
import { decideReconcile, type ReconcilePlan } from '../offline/reconcile-decision';
import { executeReconcilePlan } from '../offline/reconcile-execute';
import { createReconciler, type ReconcileOutcome, type ReconcileReason, type Reconciler } from '../offline/reconciler';
import { createReplayer, type Replayer } from '../offline/replay';
import type { CommandRegistry } from '../offline/registry';
import { discardMedia, discardOutboxRow, listUnattributableOutbox, removeFromDevice, type UserActionDeps } from '../offline/user-actions';
import { createSessionProbe, createVisibleClient } from '../offline/visible-client';
import { createWorkPackageRefresher, type WorkPackageRefresher } from '../offline/work-package';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import type { Network } from '../platform/network';
import type { UploaderPluginLike } from '../platform/uploader';
import { createStore, type ReadableStore } from './stack-store';

/** The orphan and temp-file sweeps run at most this often, however many times a stack is built. */
export const SWEEP_MIN_INTERVAL_MS = 6 * 3_600_000;
/** The `device_state` key that remembers when the sweeps last completed. */
export const SWEEP_KEY = 'media_sweep_at';

/**
 * The document step of a clip until the editor can place one (Task 9 replaces this). `missing` is what the media
 * reconciler treats as "the placeholder entry is not in the document yet": the clip's file and row are kept and the
 * entry is asked for again later with a growing wait, so nothing is deleted and nothing is lost.
 */
export const placeholderResolveVideo: ResolveVideo = () => Promise.resolve('missing');

/** What the interface can show about the offline machinery. Booleans and fixed codes only. */
export interface StackStatus {
  /** A flow was refused by the server's sign-in check: the person must sign in again. Cleared by the next accepted token. */
  auth: boolean;
  /** The server refuses this app version. Stays until the stack ends (the app has to be updated). */
  upgrade: boolean;
  /** A document could not be stored: the person must be told their edits are not being saved. Sticky until the stack ends. */
  editsNotSaved: boolean;
  /** The status code of the latest reconcile outcome (`never` before the first). */
  reconcile: ReconcileOutcome['status'];
}

/** Fixed codes the stack reports about failures it swallowed. Never an error object, an id, a path or a url. */
export type StackDiagnostic = 'replay_error' | 'refresh_error' | 'reconcile_error' | 'uploader_error' | 'media_error' | 'collab_error' | 'doc_error' | 'proof_error' | 'sweep_failed' | 'start_failed';

export type EditorEvent = { kind: 'purging' | 'quarantined' | 'unquarantined'; inspectionId: string };

/** What the editor (Task 9) supplies. Without it nothing is open in an editor and no live document is available. */
export interface EditorPorts {
  /** True while the editor has the inspection open. Defaults to "the connector holds a live connection for it". */
  isOpenInEditor?(inspectionId: string): boolean | Promise<boolean>;
  /** The live document of the open inspection, or null when the host cannot hand it out (the photo step then waits: `DOC_BUSY`). */
  liveDoc?(inspectionId: string): Doc | null;
}

export interface OfflineStackDeps {
  db: Db;
  files: Files;
  /** The authenticated wrapper: pinned origin, no redirects. */
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  /** The stored, canonical server origin. */
  origin: string;
  /** The stored identity this stack was built for. Every flow re-reads the stored identity and stops acting when it differs. */
  identity: StoredIdentity;
  /** `X-Client-*` headers; anything else is dropped. */
  clientHeaders: Record<string, string>;
  clock: Clock;
  network: Network;
  appState?: AppStatePort;
  uploaderPlugin: UploaderPluginLike;
  openSocket: SocketFactory;
  allowInsecureHttp?: boolean;
  timers?: TimerPort;
  /** Calls the listener when the device goes from locked to unlocked (`createUnlockEmitter`). */
  onUnlocked?: (listener: () => void) => () => void;
  /** Calls the listener after the server accepted this device (`AppServices.onTokenVerified`). */
  onTokenVerified?: (listener: () => void) => () => void;
  /** True when locked, expired, clock-locked or revoked. Defaults to the stored lock state, read without writing; a throw counts as locked. */
  isLocked?: () => boolean | Promise<boolean>;
  registry?: CommandRegistry;
  editor?: EditorPorts;
  /** Defaults to `placeholderResolveVideo`. */
  resolveVideo?: ResolveVideo;
  /** Every status the connector reports, after the stack has taken what it needs from it. */
  onCollabStatus?: (inspectionId: string, status: CollabStatus) => void;
  onDiagnostic?: (code: StackDiagnostic) => void;
  /** Test knobs for the shared lease and the jitter. */
  tuning?: { random?: () => number; leaseTtlMs?: number; newToken?: () => string };
}

export interface ReconcilerHandle {
  trigger(reason: ReconcileReason): void;
  onNeedsReconcile(inspectionId: string): void;
  readonly last: ReconcileOutcome;
}

export interface BoundUserActions {
  removeFromDevice: (inspectionId: string, options: Parameters<typeof removeFromDevice>[2]) => ReturnType<typeof removeFromDevice>;
  discardMedia: (pendingId: string, options: { confirmed: true }) => ReturnType<typeof discardMedia>;
  discardOutboxRow: (idempotencyKey: string, options: { confirmed: true }) => ReturnType<typeof discardOutboxRow>;
  listUnattributableOutbox: () => Promise<Awaited<ReturnType<typeof listUnattributableOutbox>>>;
}

export interface OfflineStack {
  readonly db: Db;
  /** The account this stack works for. */
  readonly account: Account;
  readonly status: ReadableStore<StackStatus>;
  readonly replayer: Replayer;
  readonly refresher: WorkPackageRefresher;
  readonly reconciler: ReconcilerHandle;
  readonly mediaReconciler: MediaReconciler;
  readonly uploader: NativeUploader;
  readonly store: MediaStore;
  /** The collaboration connector. Connections opened through it are destroyed when the stack stops. */
  readonly connector: NativeCollabConnector;
  readonly userActions: BoundUserActions;
  /** Queues one write for this account and wakes the replayer. Rejects like `enqueue`, and after `stop()`. */
  enqueue(op: string, input: unknown): Promise<OutboxRow>;
  /**
   * The plan the latest reconcile decision returned, exactly that object (it is frozen and branded: never copy it), or
   * null when the latest decision made none. Pass it as `plan` to `userActions.removeFromDevice`.
   */
  lastPlan(): ReconcilePlan | null;
  /** The editor's side of the purge and the quarantine: it must unmount the inspection on `purging` and `quarantined`. */
  onEditorEvent(listener: (event: EditorEvent) => void): () => void;
  /** Idempotent. Does nothing while the device is locked; the first unlock starts it. */
  start(): void;
  /** Terminal and idempotent. Stops every flow, removes every listener and timer, destroys open connections. */
  stop(): Promise<void>;
  /** Settles when the start sequence has launched everything it is going to (or found the stack stopped or locked). */
  settled(): Promise<void>;
  /** Settles when no replay, refresh, reconcile or media run is in progress or queued. */
  idle(): Promise<void>;
  isStopped(): boolean;
}

const CLIENT_HEADER = /^x-client-/i;

function clientHeadersOnly(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(safeClientHeaders(headers))) if (CLIENT_HEADER.test(name.trim())) kept[name] = value;
  return kept;
}

function parseSweepAt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Builds the whole offline machinery for ONE signed-in session (one origin, one account) from real adapters supplied
 * through `deps`: the outbox replayer, the work-package refresher, the reconcile pipeline, the media store, uploader and
 * reconciler, the collaboration connector, and the user actions. One blocked guard is created here and handed to every
 * module that requires it; one clock, one lock check and one lease name are shared.
 *
 * Nothing runs at construction (no request, no timer, no listener). `start()` sweeps, then starts the flows in this order:
 *  1. media uploader/reconciler (own table, no lease);
 *  2. the replayer, and WAIT for its first run: local writes reach the server before anything else decides about them;
 *  3. the reconciler (finishes stopped purges, then asks the server what is still visible), and wait for its first flow;
 *  4. the refresher. A successful refresh triggers the reconciler again (`refresh`).
 * Replay, reconcile and refresh share the `sync` lease, so they never overlap; a flow that finds it held asks again soon.
 *
 * Fail-closed: the account is re-read from the stored identity on every use and a different one means "no account"; a
 * lock check that throws means locked; `stop()` is terminal.
 */
export function createOfflineStack(deps: OfflineStackDeps): OfflineStack {
  const { db, files, http, tokens, origin, clock, network, appState } = deps;
  const bound: Account = { tenantId: deps.identity.tenantId, userId: deps.identity.userId };
  const clientHeaders = clientHeadersOnly(deps.clientHeaders);
  const insecure = deps.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: deps.allowInsecureHttp };
  const lease = { ...(deps.tuning?.leaseTtlMs === undefined ? {} : { leaseTtlMs: deps.tuning.leaseTtlMs }), ...(deps.tuning?.newToken === undefined ? {} : { newToken: deps.tuning.newToken }) };
  const random = deps.tuning?.random === undefined ? {} : { random: deps.tuning.random };
  const timers = deps.timers === undefined ? {} : { timers: deps.timers };
  const registry = deps.registry === undefined ? {} : { registry: deps.registry };
  const subscribeUnlocked = (listener: () => void): (() => void) => deps.onUnlocked?.(listener) ?? (() => undefined);

  let stopped = false;
  let started = false;
  let launched = false;
  let chain: Promise<void> = Promise.resolve();
  let latestPlan: ReconcilePlan | null = null;
  let stopping: Promise<void> | null = null;
  const teardown: (() => void)[] = [];
  const handles = new Set<{ destroy(): void }>();
  const editorListeners = new Set<(event: EditorEvent) => void>();
  const status = createStore<StackStatus>({ auth: false, upgrade: false, editsNotSaved: false, reconcile: 'never' });

  function report(code: StackDiagnostic): () => void {
    return () => {
      try {
        deps.onDiagnostic?.(code);
      } catch {
        // A failing reporter must not change what the stack does.
      }
    };
  }

  // The lock: the stored state, read without writing. Anything that cannot be read is locked.
  const isLocked = deps.isLocked ?? (async (): Promise<boolean> => evaluateLock(await loadLockState(db), clock.now()).locked);
  async function lockedNow(): Promise<boolean> {
    try {
      return (await isLocked()) !== false;
    } catch {
      return true;
    }
  }

  // The account: the stored identity, and only while it is the one this stack was built for.
  async function account(): Promise<Account | null> {
    if (stopped) return null;
    const stored = await loadIdentity(db);
    return stored !== null && stored.tenantId === bound.tenantId && stored.userId === bound.userId ? bound : null;
  }

  // ONE guard for every module that asks for one.
  const isBlocked = createBlockedGuard(db);

  const connector = createCollabConnector({
    db,
    http,
    tokens,
    network,
    origin,
    ...insecure,
    isLocked,
    openSocket: deps.openSocket,
    ...timers,
    ...random,
    clock,
    isBlocked,
    onError: () => {
      status.patch({ editsNotSaved: true });
      report('collab_error')();
    },
    onProofError: report('proof_error'),
    onStatus: (inspectionId, collabStatus) => {
      if (collabStatus === 'storage_failed') status.patch({ editsNotSaved: true });
      deps.onCollabStatus?.(inspectionId, collabStatus);
    },
  });

  let mediaReconciler: MediaReconciler | null = null;
  let reconcilerCore: Reconciler | null = null;

  const store = createMediaStore({
    db,
    files,
    isBlocked,
    onStored: () => {
      mediaReconciler?.recheckMissing();
    },
  });
  const uploader = createNativeUploader({
    store,
    http,
    tokens,
    plugin: deps.uploaderPlugin,
    origin,
    ...insecure,
    isLocked,
    clientHeaders,
    clock,
    ...timers,
    ...random,
    video: createVideoStrategy(),
    onRetry: () => {
      mediaReconciler?.trigger();
    },
    onError: report('uploader_error'),
    isBlocked,
  });
  const withDoc = createWithDoc({
    db,
    docs: { isOpen: (inspectionId) => connector.isOpen(inspectionId), liveDoc: (inspectionId) => deps.editor?.liveDoc?.(inspectionId) ?? null },
    isBlocked,
    ...timers,
    onError: report('doc_error'),
  });
  const media = createMediaReconciler({
    store,
    uploader,
    resolvePending: createPendingResolver({ withDoc }),
    resolveVideo: deps.resolveVideo ?? placeholderResolveVideo,
    isLocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    isBlocked,
    ...timers,
    ...random,
    onError: report('media_error'),
  });
  mediaReconciler = media;

  const replay = createReplayer({
    db,
    http,
    tokens,
    origin,
    ...registry,
    clientHeaders,
    ...insecure,
    account,
    isLocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    ...timers,
    ...random,
    ...lease,
    onNeedsReconcile: (inspectionId) => {
      reconcilerCore?.onNeedsReconcile(inspectionId);
    },
    isBlocked,
    onHalt: (reason) => {
      if (reason === 'auth') status.patch({ auth: true });
      else if (reason === 'upgrade') status.patch({ upgrade: true });
    },
    onError: report('replay_error'),
  });

  const refresher = createWorkPackageRefresher({
    db,
    http,
    tokens,
    origin,
    clientHeaders,
    ...insecure,
    account,
    isLocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    ...timers,
    ...random,
    ...lease,
    onHalt: (reason) => {
      if (reason === 'auth') status.patch({ auth: true });
      else status.patch({ upgrade: true });
    },
    onSummary: (summary) => {
      // A run that did its work (not halted, not turned away by another flow) may have changed what the server shows.
      if (summary.halted === null && !summary.leaseBusy) reconcilerCore?.trigger('refresh');
    },
    onError: report('refresh_error'),
  });

  // The editor's side of the purge and the quarantine, and the purge's own dependencies.
  const emitEditor = (event: EditorEvent): void => {
    for (const listener of [...editorListeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not change the purge or the quarantine.
      }
    }
  };
  const purgeDeps = {
    db,
    files,
    connector,
    uploader,
    isBlocked,
    isOpenInEditor: (inspectionId: string): boolean | Promise<boolean> => (deps.editor?.isOpenInEditor ? deps.editor.isOpenInEditor(inspectionId) : connector.isOpen(inspectionId)),
    onPurging: (inspectionId: string): void => emitEditor({ kind: 'purging', inspectionId }),
    ...registry,
  };
  const executeDeps = {
    ...purgeDeps,
    clock,
    account,
    isLocked,
    onQuarantined: (inspectionId: string): void => emitEditor({ kind: 'quarantined', inspectionId }),
    onUnquarantined: (inspectionId: string): void => {
      emitEditor({ kind: 'unquarantined', inspectionId });
      media.trigger();
      replay.trigger();
    },
    ...lease,
  };
  const visible = createVisibleClient({ http, tokens, origin, ...insecure, clientHeaders });
  const session = createSessionProbe({ http, tokens, origin, ...insecure });

  const reconcile = createReconciler({
    decide: async () => {
      const result = await decideReconcile({ db, clock, account, isLocked, visible, session, ...registry, ...lease });
      // Only the newest decision's plan is kept: an older plan must not outlive the answer that replaced it.
      latestPlan = result.kind === 'plan' ? result : null;
      return result;
    },
    execute: (plan) => executeReconcilePlan(executeDeps, plan),
    resumePurges: () => resumePurges({ ...purgeDeps, clock, account, isLocked, ...lease }),
    isLocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    ...timers,
    ...random,
    onOutcome: (outcome) => {
      status.patch({ reconcile: outcome.status });
    },
    onError: report('reconcile_error'),
  });
  reconcilerCore = reconcile;

  // User actions refuse once the stack has stopped, in addition to the real lock.
  const actionDeps: UserActionDeps = { ...purgeDeps, clock, account, isLocked: async () => stopped || (await isLocked()), ...lease };
  const userActions: BoundUserActions = {
    removeFromDevice: (inspectionId, options) => removeFromDevice(actionDeps, inspectionId, options),
    discardMedia: (pendingId, options) => discardMedia(actionDeps, pendingId, options),
    discardOutboxRow: (idempotencyKey, options) => discardOutboxRow(actionDeps, idempotencyKey, options),
    listUnattributableOutbox: async () => {
      const who = await account();
      return who === null ? { rows: [], foreign: 0 } : listUnattributableOutbox(db, who);
    },
  };

  const trackedConnector: NativeCollabConnector = {
    ...connector,
    connect: (inspectionId, opts) => {
      if (stopped) throw new Error('The offline stack has stopped');
      const handle = connector.connect(inspectionId, opts);
      handles.add(handle);
      return handle;
    },
  };

  /** The sweeps run before the uploader starts, at most once per `SWEEP_MIN_INTERVAL_MS` however often a stack is built. */
  async function sweepOnce(): Promise<void> {
    const now = clock.now();
    let last: number | null = null;
    try {
      last = parseSweepAt((await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [SWEEP_KEY]))[0]?.value);
    } catch {
      report('sweep_failed')();
    }
    // A stamp in the future is a clock that was set back: it proves nothing, so the sweep runs.
    if (last !== null && last <= now && now - last < SWEEP_MIN_INTERVAL_MS) return;
    let complete = true;
    try {
      await sweepOrphanFiles({ db, files, clock });
    } catch {
      complete = false;
      report('sweep_failed')();
    }
    try {
      const temp = await sweepUploaderTempFiles({
        files,
        clock,
        db,
        // Nothing of this stack has started yet; an upload an earlier session left running shows as an `uploading` row.
        isUploading: async () => (await store.listRows({ states: ['uploading'], limit: 1 })).length > 0,
      });
      if (temp.skipped !== undefined) complete = false;
    } catch {
      complete = false;
      report('sweep_failed')();
    }
    if (!complete || stopped) return;
    try {
      await writeDeviceState(db, SWEEP_KEY, String(Math.trunc(now)));
    } catch {
      report('sweep_failed')();
    }
  }

  async function launch(): Promise<void> {
    if (launched || stopped) return;
    launched = true;
    await sweepOnce();
    if (stopped) return;
    media.start();
    replay.start();
    await replay.idle();
    if (stopped) return;
    reconcile.start();
    await reconcile.idle();
    if (stopped) return;
    refresher.start();
  }

  function enqueueLaunch(): void {
    chain = chain.then(launch).catch(report('start_failed'));
  }

  async function begin(): Promise<void> {
    teardown.push(
      subscribeUnlocked(() => {
        if (stopped) return;
        connector.onLockChange();
        if (!launched) enqueueLaunch();
      }),
    );
    if (deps.onTokenVerified) {
      teardown.push(
        deps.onTokenVerified(() => {
          if (stopped) return;
          status.patch({ auth: false });
          // Before the start sequence has reached the reconciler, its own first flow covers this.
          if (launched) reconcile.trigger('token');
        }),
      );
    }
    if (stopped || (await lockedNow())) return;
    connector.onLockChange();
    enqueueLaunch();
  }

  async function enqueueAndTrigger(op: string, input: unknown): Promise<OutboxRow> {
    const who = await account();
    if (who === null) throw new OutboxError('invalid_account');
    const row = await enqueue({ db, clock, ...registry }, op, input, { account: who });
    replay.trigger();
    return row;
  }

  function stop(): Promise<void> {
    if (stopping !== null) return stopping;
    stopped = true;
    for (const off of teardown.splice(0)) off();
    replay.stop();
    refresher.stop();
    reconcile.stop();
    media.stop();
    for (const handle of [...handles]) {
      try {
        handle.destroy();
      } catch {
        // Already gone.
      }
    }
    handles.clear();
    editorListeners.clear();
    stopping = uploader.dispose().catch(report('uploader_error'));
    return stopping;
  }

  return {
    db,
    account: bound,
    status,
    replayer: replay,
    refresher,
    reconciler: {
      trigger: (reason) => {
        reconcile.trigger(reason);
      },
      onNeedsReconcile: (inspectionId) => {
        reconcile.onNeedsReconcile(inspectionId);
      },
      get last() {
        return reconcile.last;
      },
    },
    mediaReconciler: media,
    uploader,
    store,
    connector: trackedConnector,
    userActions,
    enqueue: enqueueAndTrigger,
    lastPlan: () => latestPlan,
    onEditorEvent: (listener) => {
      editorListeners.add(listener);
      return () => {
        editorListeners.delete(listener);
      };
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      chain = chain.then(begin).catch(report('start_failed'));
    },
    stop,
    settled: async () => {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
    // In the order the work hands over: a finished refresh wakes the reconciler, a refused write wakes it too.
    idle: async () => {
      await replay.idle();
      await refresher.idle();
      await reconcile.idle();
      await media.idle();
    },
    isStopped: () => stopped,
  };
}
