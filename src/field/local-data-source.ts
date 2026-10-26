import type { CollabConnector, CommandData, CommandResult, ExecuteOptions, FieldCommand, FieldDataSource, NotifyOptions, NotifyVariant, SessionInfo } from '@inspectorhub/field-ui';
import type { NativeUploader } from '../media/native-uploader';
import type { MediaStore } from '../media/store';
import { createBlockedGuard, type IsBlocked } from '../offline/blocked';
import type { Account } from '../offline/outbox';
import type { ReconcilerHandle } from '../app/offline-stack';
import type { WorkPackageRefresher } from '../offline/work-package';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { httpsHref } from '../platform/https-href';
import type { TimerPort } from '../collab/timers';
import type { Api } from './api-client';
import { createAfterWrite } from './after-write';
import { wrapCollab } from './collab-wrapper';
import { createExecutor } from './commands';
import { createEditorLoader } from './editor-data';
import type { EditorRegistry } from './editor-registry';
import { failureOf, MESSAGES } from './messages';
import { withMediaCleanup } from './media-cleanup';
import type { NetworkFlag } from './network-flag';
import { createMemoryPhotoIndex, createPhotoUrls, indexUploadedRows, type PhotoIndex } from './photo-urls';
import { hasQueuedWrites } from './queued-writes';
import { createResources } from './resources';
import type { WithDoc } from '../media/pending-doc';
import { createKeptNotice } from './kept-notice';
import { createStoredBlobReader, createUploaderFactory } from './uploader';
import { createForegroundUploads } from './uploader-foreground';
import { createVideoAdapter, type DeferredResolveVideo } from './video-adapter';

/**
 * The editor's `FieldDataSource` for the app, assembled from the pieces of the offline stack and the modules of this
 * folder. Where each member comes from:
 *
 *  - `load`: the work-package cache (`editor-data.ts`), refused for a blocked inspection; `execute`: `commands.ts`;
 *  - `collab`: the stack's connector, wrapped so the editor registry sees the open document (`collab-wrapper.ts`) and
 *    so a photo removed in the editor loses its device row (`media-cleanup.ts`);
 *  - `media`: the device store, and one uploader that sends each kind the way it has to go (`uploader.ts`);
 *  - `resources`: the engine routes online, the empty answer offline (`resources.ts`), and the video flow
 *    (`video-adapter.ts`);
 *  - `urls`: see below; `platform`: the native shell the editor adapts its bars to.
 *
 * Not provided on purpose: the human-verification slot. The package's default fails closed, so a publish is refused
 * until the product decides what the native shell may do there.
 */

export interface NotifySink {
  (message: string, variant: NotifyVariant, options?: NotifyOptions): void;
}

/** What of the offline stack this reads (`OfflineStack` satisfies it). */
export interface LocalStack {
  readonly db: Db;
  readonly account: Account;
  readonly store: MediaStore;
  /** Runs a function against the results document of an inspection (`OfflineStack.withDoc`). */
  readonly withDoc: WithDoc;
  readonly uploader: Pick<NativeUploader, 'uploadDetailed'>;
  readonly connector: CollabConnector;
  readonly refresher: Pick<WorkPackageRefresher, 'refreshInspection'>;
  readonly reconciler: Pick<ReconcilerHandle, 'trigger'>;
  enqueue(op: string, input: unknown): Promise<unknown>;
  idle(): Promise<void>;
  /** True while the server speaks an older contract than this app needs (`OfflineStack.serverTooOld`). Omitted: never. */
  serverTooOld?(): boolean;
}

export interface LocalDataSourceDeps {
  stack: LocalStack;
  /** The Bearer client for the editor's online requests. */
  api: Api;
  files: Pick<Files, 'read'>;
  network: Pick<NetworkFlag, 'isOnline' | 'onOnlineChange'>;
  registry: EditorRegistry;
  /** The signed-in user's session snapshot (`loadSessionInfo`). */
  session: SessionInfo;
  /** The stored, canonical server origin. */
  origin: string;
  /**
   * False while a required update turns editing off (`clientPolicy(...).canEdit`): `execute` of any command and every way into the
   * media store or uploader answer one fixed sentence and do nothing. Reading (`load`, the resources, the stored photos) is
   * unaffected, and so is everything the offline stack does with what is already on the device (the outbox, the uploader,
   * the replayer): captured work is always delivered. Omitted: editing is allowed.
   */
  canEdit?(): boolean;
  platform: 'ios' | 'android';
  /** The time stamped on an inspector signature. It MUST be anchored to the server's clock: the device clock can be set to any time. */
  signedAtMs(): number;
  clock: Clock;
  timers: TimerPort;
  /** Where the editor's messages go (the app's toast host). */
  notify: NotifySink;
  /** Opens an address in the system browser. Only https addresses are ever handed to it. */
  openExternal(url: string): Promise<void>;
  /** Leaves the editor screen. */
  onExit(): void;
  /** Re-reads the editor data. */
  onReload(): void;
  /** Starts the editor over from a clean mount; leave out when the screen cannot. */
  onRestart?(): void;
  /** Defaults to the stack's blocked guard over its database. */
  isBlocked?: IsBlocked;
  photoIndex?: PhotoIndex;
  /** A fresh UUID. Defaults to `crypto.randomUUID`. */
  newId?(): string;
  /** The write succeeded but the cached copy could not be brought up to date. */
  onCacheStale?(inspectionId: string): void;
  /** Receives the failures the modules swallow. Never receives a token or a path. */
  onError?(error: unknown): void;
  /** The stack's document step for clips: bound to the real one here. */
  resolveVideo?: DeferredResolveVideo;
}

/** A host that is not a real one: presence is off, so this address is never opened. */
const PRESENCE_OFF_ORIGIN = 'wss://presence-off.invalid';

export function createLocalDataSource(deps: LocalDataSourceDeps): FieldDataSource {
  const { stack } = deps;
  const isBlocked = deps.isBlocked ?? createBlockedGuard(stack.db);
  const photoIndex = deps.photoIndex ?? createMemoryPhotoIndex();
  const photoUrl = createPhotoUrls({ tenantId: stack.account.tenantId, index: photoIndex });
  const report = (error: unknown): void => {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter changes nothing about what the editor does.
    }
  };

  /** The sink may fail (the toast host is gone); that is reported and never reaches the editor. */
  const say = (message: string, variant: NotifyVariant, options?: NotifyOptions): void => {
    try {
      deps.notify(message, variant, options);
    } catch (error) {
      report(error);
    }
  };

  const load = createEditorLoader({ db: stack.db, account: stack.account, isBlocked });
  const afterWrite = createAfterWrite({ refresher: stack.refresher, settle: () => stack.idle(), timers: deps.timers });
  const canEdit = (): boolean => {
    try {
      return deps.canEdit?.() !== false;
    } catch {
      // The state cannot be read: it is not known, and unknown is allowed.
      return true;
    }
  };
  const runCommand = createExecutor({
    isBlocked,
    isOnline: () => deps.network.isOnline(),
    enqueue: (op, input) => stack.enqueue(op, input),
    api: deps.api,
    signedAtMs: () => deps.signedAtMs(),
    hasQueuedWrites: (inspectionId) => hasQueuedWrites(stack.db, stack.account, inspectionId),
    afterWrite,
    ...(deps.onCacheStale === undefined ? {} : { onCacheStale: deps.onCacheStale }),
    loadScope: async (inspectionId, scope) => (await load(inspectionId, scope)).results,
  });

  const execute = <C extends FieldCommand>(inspectionId: string, cmd: C, opts?: ExecuteOptions): Promise<CommandResult<CommandData<C>>> =>
    canEdit() ? runCommand(inspectionId, cmd, opts) : Promise.resolve(failureOf<CommandData<C>>(MESSAGES.editingOff));

  const sendPhoto = createUploaderFactory({
    isBlocked,
    store: stack.store,
    withDoc: stack.withDoc,
    native: stack.uploader,
    foreground: createForegroundUploads({
      api: deps.api,
      readStoredBlob: createStoredBlobReader(stack.store, deps.files),
      isSynced: (inspectionId) => deps.registry.getHandle(inspectionId)?.synced() ?? false,
    }),
    onError: report,
    onKept: createKeptNotice({ timers: deps.timers, say: (message) => say(message, 'info') }),
  });

  const uploader: typeof sendPhoto = (inspectionId, doc) => {
    const inner = sendPhoto(inspectionId, doc);
    return {
      // Refused before anything is stored or sent only when the app itself must be updated. A server that is too old
      // does not refuse: the photo is kept like an offline one (row and document entry) and waits for the server to be
      // updated; the sentence it answers with names that, not the lock.
      upload: async (rec) => {
        if (!canEdit()) return { ok: false, error: MESSAGES.editingOff };
        // The other kinds (a defect photo, a crop, an annotation) keep nothing yet, so they still stop before a request.
        const keepsPhoto = rec.kind === 'photo' && rec.meta.targetType !== 'defect';
        if (!keepsPhoto && stack.serverTooOld?.() === true) return { ok: false, error: MESSAGES.serverTooOld };
        const result = await inner.upload(rec);
        return !result.ok && 'kept' in result && result.kept === true && stack.serverTooOld?.() === true ? { ...result, error: MESSAGES.serverTooOld } : result;
      },
    };
  };
  const mediaStore: typeof stack.store = Object.assign(Object.create(stack.store) as typeof stack.store, {
    put: (rec: Parameters<typeof stack.store.put>[0]) => (canEdit() ? stack.store.put(rec) : Promise.reject(new Error(MESSAGES.editingOff))),
  });

  const videoAdapter = createVideoAdapter({
    api: deps.api,
    store: stack.store,
    isBlocked,
    isOnline: () => deps.network.isOnline(),
    videoProvider: () => deps.session.videoProvider,
    origin: deps.origin,
    clock: deps.clock,
    newId: deps.newId ?? (() => crypto.randomUUID()),
  });
  deps.resolveVideo?.bind(videoAdapter.resolveVideo);

  const resources = createResources({
    api: deps.api,
    db: stack.db,
    account: stack.account,
    isOnline: () => deps.network.isOnline(),
    isBlocked,
    photoUrl,
    afterWrite,
  });

  return {
    load: async (inspectionId, scope) => {
      const data = await load(inspectionId, scope);
      // Photos that are on the server but whose file is still on this device can be shown from it.
      if (scope === undefined) await indexUploadedRows(photoIndex, stack.store, inspectionId);
      return data;
    },
    session: () => deps.session,
    execute,
    notify: (message, variant = 'info', options) => say(message, variant, options),
    reload: () => deps.onReload(),
    ...(deps.onRestart === undefined ? {} : { restartSession: () => deps.onRestart?.() }),
    openUrl: (url) => {
      // The normalised address is what is opened, so what was checked is what is sent.
      const href = httpsHref(url);
      if (href === null) {
        say(MESSAGES.linkBlocked, 'warning');
        return;
      }
      const failed = (error: unknown): void => {
        report(error);
        say(MESSAGES.linkNotOpened, 'warning');
      };
      try {
        deps.openExternal(href).catch(failed);
      } catch (error) {
        failed(error);
      }
    },
    exit: () => {
      deps.onExit();
      // Writes the person made in the editor may have queued follow-ups: look at the server again now.
      try {
        stack.reconciler.trigger('follow_up');
      } catch (error) {
        report(error);
      }
    },
    isOnline: () => deps.network.isOnline(),
    onOnlineChange: (cb) => deps.network.onOnlineChange(cb),
    collab: withMediaCleanup(wrapCollab(stack.connector, deps.registry), { store: stack.store, onError: report }),
    media: { store: mediaStore, uploader },
    urls: {
      photo: photoUrl,
      // The report preview, the PDFs and the video objects are server pages that need the web session; the app has none.
      reportPreview: () => null,
      reportPdf: () => null,
      statutoryPreviewPdf: () => null,
      videoObject: () => null,
      // The package requires an address for the cost download. This one goes nowhere: the cost tables are downloaded from the web app.
      costExport: () => '#',
      // Presence is off (the session names no user), so the editor never opens this; it must still be a string.
      presenceSocket: (inspectionId) => `${PRESENCE_OFF_ORIGIN}/${encodeURIComponent(inspectionId)}`,
      editorPath: (inspectionId) => `/inspections/${encodeURIComponent(inspectionId)}/edit`,
    },
    resources: { ...resources, video: videoAdapter.video },
    platform: deps.platform,
  };
}
