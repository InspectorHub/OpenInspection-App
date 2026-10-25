import type { Doc } from 'yjs';
import type { Http } from '../auth/http';
import { safeClientHeaders } from '../auth/client-headers';
import { loadIdentity, writeDeviceState, type StoredIdentity } from '../auth/server-config';
import type { TokenManager } from '../auth/tokens';
import { CollabIssue, createCollabConnector, type CollabStatus, type NativeCollabConnector, type SocketFactory } from '../collab/connector';
import { realTimers, type TimerPort } from '../collab/timers';
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
import { createReconciler, isReconcileUnsupported, type ReconcileOutcome, type ReconcileReason, type Reconciler } from '../offline/reconciler';
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
import { createDiagnosticRing } from './diagnostics';
import { createRefreshAfterReplay } from './refresh-after-replay';
import { createStore, type ReadableStore } from './stack-store';
import type { TimingCode } from './timings';

/** The orphan and temp-file sweeps run at most this often, however many times a stack is built. */
export const SWEEP_MIN_INTERVAL_MS = 6 * 3_600_000;
/** The `device_state` key that remembers when the orphan-file sweep last completed. */
export const SWEEP_KEY = 'media_sweep_at';
/** The key of the uploader temp-copy sweep. Apart from the orphan sweep, because that one is skipped while a row says `uploading` (after a crash one always does). */
export const TEMP_SWEEP_KEY = 'media_temp_sweep_at';
/** A sweep that has not answered by then is abandoned (its result ignored) and the start sequence goes on without it. */
export const SWEEP_TIMEOUT_MS = 10_000;
/** The first replay run found the shared lease held by someone else: wait this long, then ask again. */
export const LAUNCH_LEASE_WAIT_MS = 2_500;
/** How many times the start sequence waits for the lease before it goes on anyway. */
export const LAUNCH_LEASE_MAX_WAITS = 5;
/** With `deferLaunchUntilPainted`: the longest the start sequence waits for the work list's first paint before it goes on anyway. */
export const LAUNCH_PAINT_CAP_MS = 3_000;

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
  /** The collaboration itself failed (a socket that would not open, a frame or callback that broke); the stored document is fine. Cleared by the next synced document. */
  collabIssue: boolean;
  /** The status code of the latest reconcile outcome (`never` before the first). */
  reconcile: ReconcileOutcome['status'];
}

/** Fixed codes the stack reports about failures it swallowed. Never an error object, an id, a path or a url. */
export type StackDiagnostic = 'replay_error' | 'refresh_error' | 'reconcile_error' | 'uploader_error' | 'media_error' | 'collab_error' | 'doc_error' | 'proof_error' | 'sweep_failed' | 'sweep_timeout' | 'start_failed' | 'factory_failed';

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
  /** A measured duration, under a fixed code. Never receives anything else. A throw is ignored. */
  onTiming?: (code: TimingCode, ms: number) => void;
  /**
   * Holds the start sequence (the sweeps, the first replay, the reconcile, the refresher) back until the work list has painted
   * its first snapshot (`markListPainted`) or `LAUNCH_PAINT_CAP_MS` has passed, so the list's own reads do not queue behind them
   * on the single database connection. Only the moment the sequence begins moves; its order and what it does are unchanged.
   */
  deferLaunchUntilPainted?: boolean;
  /**
   * True while the server speaks an older contract than this app needs. Every flow that talks to the server (replay, refresh,
   * reconcile, uploads, collaboration) then behaves as if the device were locked, and resumes by itself when this turns false;
   * everything that only touches the device (the outbox, the media store, the documents, the user actions) is unaffected.
   * Omitted: never too old. An unknown answer must be reported as false.
   */
  serverTooOld?: ReadableStore<boolean>;
  /**
   * Looks at the server's contract: asked when the start sequence begins, and only while the device is online (a request to find
   * out is never made offline), and again on the offline-to-online edge while `compatKnown()` says no answer has arrived yet
   * (one look at a time, no polling). The replay, reconcile and refresh wait for the first look (a bounded time); the sweeps
   * do not, and the media uploader starts when both are done. Anything it throws or rejects is ignored.
   */
  beforeLaunch?: () => Promise<void>;
  /** True once a compat answer for this server has been received. Without it the online edge asks for nothing. */
  compatKnown?: () => boolean;
  /**
   * Whether the server is known to have the check for removed inspections: false skips that check before any request (see
   * `ReconcileDeps.reconcileSupported`). True or null runs it.
   */
  reconcileSupported?: () => boolean | null;
  /** The check for removed inspections was refused as unsupported by the server itself (it has no such route). */
  onReconcileUnsupported?: () => void;
  /** Test knobs for the shared lease and the jitter. */
  tuning?: { random?: () => number; leaseTtlMs?: number; newToken?: () => string };
}

export interface ReconcilerHandle {
  trigger(reason: ReconcileReason): void;
  onNeedsReconcile(inspectionId: string): void;
  readonly last: ReconcileOutcome;
  /** Settles when no reconcile flow is running or queued. Optional only so test doubles need not supply it; the real stack always does. */
  idle?(): Promise<void>;
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
  /** True while the server speaks an older contract than this app needs. For the data source and the api client of the editor. */
  serverTooOld(): boolean;
  /** The answer every flow that talks to the server is given: locked, stopped, or the server too old. */
  syncBlocked(): Promise<boolean>;
  /** True when the offline lock holds or the stack has stopped; the server being too old is NOT in it (`serverTooOld`). */
  locked(): Promise<boolean>;
  /** Queues one write for this account and wakes the replayer. Rejects like `enqueue`, and after `stop()`. */
  enqueue(op: string, input: unknown): Promise<OutboxRow>;
  /**
   * The plan the latest reconcile decision returned, exactly that object (it is frozen and branded: never copy it), or
   * null when the latest decision made none. Pass it as `plan` to `userActions.removeFromDevice`.
   */
  lastPlan(): ReconcilePlan | null;
  /** The latest fixed diagnostic codes this stack reported, oldest first (a small ring). Codes only: never an id, a path or a url. */
  recentDiagnostics(): readonly StackDiagnostic[];
  /** The editor's side of the purge and the quarantine: it must unmount the inspection on `purging` and `quarantined`. */
  onEditorEvent(listener: (event: EditorEvent) => void): () => void;
  /** The work list painted its first snapshot: lets a deferred start sequence begin. Idempotent; harmless after `stop()`. */
  markListPainted(): void;
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
 * Nothing runs at construction (no request, no timer, no listener). `start()` starts the flows in this order:
 *  1. the sweeps (orphan files, uploader temp copies) run at once but hold nothing up: after `SWEEP_TIMEOUT_MS` a sweep that has
 *     not answered is abandoned. The media uploader/reconciler (own table, no lease) starts when they are done or abandoned;
 *  2. the replayer, and WAIT for its first run, also when that run was turned away by the lease (a bounded number of retries):
 *     local writes reach the server before anything else decides about them;
 *  3. the reconciler (finishes stopped purges, then asks the server what is still visible), and wait for its first flow. No
 *     trigger reaches it before this point: an accepted token or a refused write cannot start a flow ahead of the replayer;
 *  4. the refresher. A successful refresh triggers the reconciler again (`refresh`).
 * Replay, reconcile and refresh share the `sync` lease, so they never overlap; a flow that finds it held asks again soon.
 *
 * Fail-closed: the account is re-read from the stored identity on every use and a different one means "no account"; a
 * lock check that throws means locked; `stop()` is terminal, and every flow's lock check answers "locked" from then on.
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
  // Flows resume on an unlock, and also when a server that was too old stops being so.
  const resumeListeners = new Set<() => void>();
  const subscribeUnlocked = (listener: () => void): (() => void) => {
    const off = deps.onUnlocked?.(listener) ?? (() => undefined);
    resumeListeners.add(listener);
    return () => {
      off();
      resumeListeners.delete(listener);
    };
  };

  let stopped = false;
  let started = false;
  let launched = false;
  /** Set right after `reconcile.start()`. Before it no trigger may reach the reconciler: its first flow must follow the first replay. */
  let reconcileStarted = false;
  let mediaStarted = false;
  let painted = false;
  let markPainted: () => void = () => undefined;
  const listPainted = new Promise<void>((resolve) => {
    markPainted = () => {
      painted = true;
      resolve();
    };
  });
  let chain: Promise<void> = Promise.resolve();
  let latestPlan: ReconcilePlan | null = null;
  let stopping: Promise<void> | null = null;
  const teardown: (() => void)[] = [];
  const timerPort = deps.timers ?? realTimers;
  /** The waits of the start sequence: `stop()` ends every one of them. */
  const releases = new Set<() => void>();
  const diagnosticRing = createDiagnosticRing<StackDiagnostic>();
  const handles = new Set<{ destroy(): void }>();
  const editorListeners = new Set<(event: EditorEvent) => void>();
  const status = createStore<StackStatus>({ auth: false, upgrade: false, editsNotSaved: false, collabIssue: false, reconcile: 'never' });

  function report(code: StackDiagnostic): () => void {
    return () => {
      diagnosticRing.push(code);
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

  // What every flow is handed as its lock check: the real one, and "locked" for good once the stack has stopped, so nothing that
  // was waiting for an answer (a ticket, a destination url) can start work after the session ended.
  const stackLocked = async (): Promise<boolean> => stopped || (await isLocked()) !== false;
  // What the flows that talk to the server are handed: the same answer, and also "locked" while the server is too old.
  // Local work (the user actions, the purge, the documents) keeps `stackLocked`: it needs no server.
  // A native upload that is already in flight when the server turns out to be too old is not cancelled: the platform owns it and
  // it finishes or fails on its own; what stops is every request that would START after the answer.
  const syncBlocked = async (): Promise<boolean> => (await stackLocked()) || deps.serverTooOld?.get() === true;

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
    isLocked: syncBlocked,
    openSocket: deps.openSocket,
    ...timers,
    ...random,
    clock,
    isBlocked,
    // Only a failure to store the document means "your edits are not being saved". The collaboration failing (a socket, a
    // frame, a callback) is a separate, non-sticky signal: the document on the device is intact.
    onError: (error) => {
      if (error instanceof CollabIssue) status.patch({ collabIssue: true });
      else status.patch({ editsNotSaved: true });
      report('collab_error')();
    },
    onProofError: report('proof_error'),
    onStatus: (inspectionId, collabStatus) => {
      if (collabStatus === 'storage_failed') status.patch({ editsNotSaved: true });
      else if (collabStatus === 'synced') status.patch({ collabIssue: false });
      else if (collabStatus === 'signed_out' || collabStatus === 'auth_rejected') status.patch({ auth: true });
      else if (collabStatus === 'upgrade_required') status.patch({ upgrade: true });
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
    isLocked: syncBlocked,
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
    isLocked: syncBlocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    isBlocked,
    ...timers,
    ...random,
    onError: report('media_error'),
    onHalt: (code) => {
      if (code === 'AUTH') status.patch({ auth: true });
      else if (code === 'UPGRADE') status.patch({ upgrade: true });
    },
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
    isLocked: syncBlocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    ...timers,
    ...random,
    ...lease,
    onNeedsReconcile: (inspectionId) => {
      // Before the reconciler has started, its first flow (which follows the first replay) covers this write.
      if (reconcileStarted) reconcilerCore?.onNeedsReconcile(inspectionId);
    },
    // What the server holds changed: the cached copy the editor reads is refreshed, for those inspections only.
    onInspectionsSent: (inspectionIds) => {
      // Until the start sequence has launched the refresher, its own full refresh follows the first replay and covers these.
      if (!refresherLaunched) return;
      const pending = refreshAfterReplay(inspectionIds);
      afterReplay.add(pending);
      void pending.finally(() => afterReplay.delete(pending));
    },
    isBlocked,
    onHalt: (reason) => {
      if (reason === 'auth') status.patch({ auth: true });
      else if (reason === 'upgrade') status.patch({ upgrade: true });
    },
    onError: report('replay_error'),
  });

  let refresherLaunched = false;
  const afterReplay = new Set<Promise<void>>();
  const refreshAfterReplay = createRefreshAfterReplay({ refresher: { refreshInspection: (id) => refresher.refreshInspection(id) }, settle: async () => {
      await refresher.idle();
      await reconcile.idle();
    }, isStopped: () => stopped });

  const refresher = createWorkPackageRefresher({
    db,
    http,
    tokens,
    origin,
    clientHeaders,
    ...insecure,
    account,
    isLocked: syncBlocked,
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
      if (summary.halted === null && !summary.leaseBusy) triggerReconcile('refresh');
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
    isLocked: stackLocked,
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
      const result = await decideReconcile({ db, clock, account, isLocked: syncBlocked, visible, session, ...registry, ...lease, ...(deps.reconcileSupported === undefined ? {} : { reconcileSupported: deps.reconcileSupported }) });
      // Only the newest decision's plan is kept: an older plan must not outlive the answer that replaced it, nor the stack.
      latestPlan = result.kind === 'plan' && !stopped ? result : null;
      return result;
    },
    execute: (plan) => executeReconcilePlan(executeDeps, plan),
    resumePurges: () => resumePurges({ ...purgeDeps, clock, account, isLocked: stackLocked, ...lease }),
    isLocked: syncBlocked,
    onUnlocked: subscribeUnlocked,
    network,
    ...(appState === undefined ? {} : { appState }),
    clock,
    ...timers,
    ...random,
    onOutcome: (outcome) => {
      if (isReconcileUnsupported(outcome)) {
        try {
          deps.onReconcileUnsupported?.();
        } catch {
          // A failing reporter changes nothing about the outcome.
        }
      }
      status.patch({
        reconcile: outcome.status,
        ...(outcome.status === 'auth' ? { auth: true } : {}),
        ...(outcome.status === 'halt' && outcome.reason === 'upgrade_required' ? { upgrade: true } : {}),
      });
    },
    onError: report('reconcile_error'),
  });
  reconcilerCore = reconcile;

  // User actions refuse once the stack has stopped, in addition to the real lock.
  const actionDeps: UserActionDeps = { ...purgeDeps, clock, account, isLocked: stackLocked, ...lease };
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
      // The caller's own destroy() ends the tracking: the set holds only what stop() still has to close.
      const tracked: typeof handle = {
        get doc() {
          return handle.doc;
        },
        persistenceSynced: handle.persistenceSynced,
        synced: () => handle.synced(),
        destroy: () => {
          handles.delete(tracked);
          handle.destroy();
        },
      };
      handles.add(tracked);
      return tracked;
    },
  };

  /** Every reconcile trigger of the stack goes through here: none reaches the reconciler before its first flow has been started. */
  function triggerReconcile(reason: ReconcileReason): void {
    if (reconcileStarted) reconcile.trigger(reason);
  }

  /** A pause that `stop()` ends early. */
  function pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown = null;
      const release = (): void => {
        timerPort.clearTimeout(handle);
        releases.delete(release);
        resolve();
      };
      try {
        handle = timerPort.setTimeout(release, ms);
      } catch {
        resolve();
        return;
      }
      releases.add(release);
    });
  }

  async function stampDue(key: string, now: number): Promise<boolean> {
    let last: number | null = null;
    try {
      last = parseSweepAt((await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]))[0]?.value);
    } catch {
      report('sweep_failed')();
    }
    // A stamp in the future is a clock that was set back: it proves nothing, so the sweep runs.
    return !(last !== null && last <= now && now - last < SWEEP_MIN_INTERVAL_MS);
  }

  async function writeStamp(key: string, now: number): Promise<void> {
    try {
      await writeDeviceState(db, key, String(Math.trunc(now)));
    } catch {
      report('sweep_failed')();
    }
  }

  /**
   * The sweeps, each at most once per `SWEEP_MIN_INTERVAL_MS` however often a stack is built. Each has its own stamp: the temp
   * sweep is skipped while a row says `uploading` (after a crash one does), which must not make the orphan sweep repeat.
   * `live()` turns false when the stack stops or the sweep is abandoned; a sweep that is no longer live writes nothing.
   */
  async function sweepOnce(live: () => boolean): Promise<void> {
    const now = clock.now();
    if (await stampDue(SWEEP_KEY, now)) {
      let complete = true;
      try {
        await sweepOrphanFiles({ db, files, clock });
      } catch {
        complete = false;
        report('sweep_failed')();
      }
      if (complete && live()) await writeStamp(SWEEP_KEY, now);
    }
    if (!live()) return;
    if (await stampDue(TEMP_SWEEP_KEY, now)) {
      let complete = true;
      try {
        const temp = await sweepUploaderTempFiles({
          files,
          clock,
          db,
          // The uploader of this stack has not started; an upload an earlier session left running shows as an `uploading` row.
          isUploading: async () => (await store.listRows({ states: ['uploading'], limit: 1 })).length > 0,
        });
        if (temp.skipped !== undefined) complete = false;
      } catch {
        complete = false;
        report('sweep_failed')();
      }
      if (complete && live()) await writeStamp(TEMP_SWEEP_KEY, now);
    }
  }

  /** Runs the sweeps and settles when they are done, abandoned (`SWEEP_TIMEOUT_MS`) or the stack stopped. Never rejects. */
  async function runSweeps(): Promise<void> {
    let abandoned = false;
    let cancelTimeout: () => void = () => undefined;
    const work = sweepOnce(() => !stopped && !abandoned).catch(report('sweep_failed'));
    const timeout = new Promise<void>((resolve) => {
      let handle: unknown = null;
      const release = (): void => {
        timerPort.clearTimeout(handle);
        releases.delete(release);
        resolve();
      };
      try {
        handle = timerPort.setTimeout(() => {
          abandoned = true;
          report('sweep_timeout')();
          release();
        }, SWEEP_TIMEOUT_MS);
      } catch {
        // No timer could be set: the sweeps are waited for on their own.
        return;
      }
      releases.add(release);
      cancelTimeout = release;
    });
    await Promise.race([work, timeout]);
    cancelTimeout();
  }

  /**
   * Starts the replayer and waits for its first run. A run turned away by the lease (another holder) is asked again after a
   * short wait, a bounded number of times, so the reconciler's first flow never gets ahead of the first replay.
   */
  async function firstReplay(): Promise<void> {
    replay.start();
    let result = await replay.replay();
    for (let waits = 0; result.leaseBusy && waits < LAUNCH_LEASE_MAX_WAITS && !stopped; waits += 1) {
      await pause(LAUNCH_LEASE_WAIT_MS);
      if (stopped) return;
      result = await replay.replay();
    }
    await replay.idle();
  }

  /** Waits for the paint, the cap or `stop()`, whichever comes first. The cap timer never outlives the wait. */
  function untilPaintedOrCap(): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown = null;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        timerPort.clearTimeout(handle);
        releases.delete(finish);
        resolve();
      };
      try {
        handle = timerPort.setTimeout(finish, LAUNCH_PAINT_CAP_MS);
      } catch {
        // No timer could be set: do not wait at all rather than risk waiting for ever.
        resolve();
        return;
      }
      releases.add(finish);
      void listPainted.then(finish);
    });
  }

  /** One look at the server's contract at a time; anything that asks while one is running shares it. Never rejects. */
  let contractLook: Promise<void> | null = null;
  function lookAtContract(): Promise<void> {
    if (contractLook !== null) return contractLook;
    const beforeLaunch = deps.beforeLaunch;
    if (beforeLaunch === undefined) return Promise.resolve();
    const look = (async (): Promise<void> => {
      if (!(await network.online().catch(() => false))) return;
      await Promise.resolve()
        .then(beforeLaunch)
        .catch(() => undefined);
    })().finally(() => {
      contractLook = null;
    });
    contractLook = look;
    return look;
  }

  async function launch(): Promise<void> {
    if (launched || stopped) return;
    launched = true;
    if (deps.deferLaunchUntilPainted === true && !painted) {
      const waitedFrom = clock.now();
      await untilPaintedOrCap();
      if (stopped) return;
      try {
        deps.onTiming?.('launch_wait_ms', Math.max(0, clock.now() - waitedFrom));
      } catch {
        // A failing reporter must not change what the stack does.
      }
    }
    // The look at the server's contract and the sweeps run side by side: the sweeps are local and wait for nobody. Every flow that
    // talks to the server waits for the look (at most its own timeout), and so does the uploader, which also waits for the sweeps.
    const lookedAt = lookAtContract();
    // The sweeps hold nothing up but the uploader, which must not start while the temp sweep looks for copies of finished uploads.
    const mediaUp = Promise.all([runSweeps(), lookedAt]).then(() => {
      if (stopped) return;
      media.start();
      mediaStarted = true;
    });
    await lookedAt;
    if (stopped) return;
    await firstReplay();
    if (stopped) return;
    reconcile.start();
    reconcileStarted = true;
    await reconcile.idle();
    if (stopped) return;
    refresher.start();
    refresherLaunched = true;
    await mediaUp;
  }

  function enqueueLaunch(): void {
    chain = chain.then(launch).catch(report('start_failed'));
  }

  async function begin(): Promise<void> {
    // `start(); stop();` in one tick: nothing is subscribed that nobody would ever unsubscribe.
    if (stopped) return;
    teardown.push(
      subscribeUnlocked(() => {
        if (stopped) return;
        connector.onLockChange();
        if (!launched) enqueueLaunch();
      }),
    );
    if (deps.beforeLaunch !== undefined) {
      // A cold start that was offline or timed out knows nothing about the server. Unknown means allowed, by design, so nothing is
      // blocked meanwhile; the first time the link comes back, and again only while still unknown, the server is asked.
      teardown.push(
        network.onChange((online) => {
          if (online && !stopped && deps.compatKnown?.() === false) void lookAtContract();
        }),
      );
    }
    if (deps.serverTooOld) {
      const contract = deps.serverTooOld;
      teardown.push(
        contract.subscribe(() => {
          if (stopped) return;
          // Too old: a connection that is open ends at once. No longer too old: every flow that waited for it asks again.
          if (contract.get()) connector.onLockChange();
          else for (const resume of [...resumeListeners]) resume();
        }),
      );
    }
    if (deps.onTokenVerified) {
      teardown.push(
        deps.onTokenVerified(() => {
          if (stopped) return;
          status.patch({ auth: false });
          // Before the start sequence has reached the reconciler, its own first flow covers this.
          triggerReconcile('token');
          // A run of uploads halted for the sign-in resumes at once instead of waiting for its slow timer.
          if (mediaStarted) media.trigger();
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
    latestPlan = null;
    for (const off of teardown.splice(0)) off();
    for (const release of [...releases]) release();
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
      trigger: triggerReconcile,
      onNeedsReconcile: (inspectionId) => {
        if (reconcileStarted) reconcile.onNeedsReconcile(inspectionId);
      },
      get last() {
        return reconcile.last;
      },
      idle: () => reconcile.idle(),
    },
    mediaReconciler: media,
    uploader,
    store,
    connector: trackedConnector,
    userActions,
    enqueue: enqueueAndTrigger,
    serverTooOld: () => deps.serverTooOld?.get() === true,
    syncBlocked,
    locked: stackLocked,
    lastPlan: () => (stopped ? null : latestPlan),
    recentDiagnostics: () => diagnosticRing.recent(),
    onEditorEvent: (listener) => {
      editorListeners.add(listener);
      return () => {
        editorListeners.delete(listener);
      };
    },
    markListPainted: () => {
      markPainted();
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
      await Promise.all([...afterReplay]);
      await refresher.idle();
      await reconcile.idle();
      await media.idle();
    },
    isStopped: () => stopped,
  };
}
