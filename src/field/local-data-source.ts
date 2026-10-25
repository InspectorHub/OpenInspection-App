import type { CollabConnector, FieldDataSource, NotifyOptions, NotifyVariant, SessionInfo } from '@inspectorhub/field-ui';
import type { NativeUploader } from '../media/native-uploader';
import type { MediaStore } from '../media/store';
import { createBlockedGuard, type IsBlocked } from '../offline/blocked';
import type { Account } from '../offline/outbox';
import type { ReconcilerHandle } from '../app/offline-stack';
import type { WorkPackageRefresher } from '../offline/work-package';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import type { TimerPort } from '../collab/timers';
import type { Api } from './api-client';
import { createAfterWrite } from './after-write';
import { wrapCollab } from './collab-wrapper';
import { createExecutor } from './commands';
import { createEditorLoader } from './editor-data';
import type { EditorRegistry } from './editor-registry';
import { MESSAGES } from './messages';
import { withMediaCleanup } from './media-cleanup';
import type { NetworkFlag } from './network-flag';
import { createMemoryPhotoIndex, createPhotoUrls, indexUploadedRows, type PhotoIndex } from './photo-urls';
import { hasQueuedWrites } from './queued-writes';
import { createResources } from './resources';
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
  readonly uploader: Pick<NativeUploader, 'uploadDetailed'>;
  readonly connector: CollabConnector;
  readonly refresher: Pick<WorkPackageRefresher, 'refreshInspection'>;
  readonly reconciler: Pick<ReconcilerHandle, 'trigger'>;
  enqueue(op: string, input: unknown): Promise<unknown>;
  idle(): Promise<void>;
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

  const load = createEditorLoader({ db: stack.db, account: stack.account, isBlocked });
  const afterWrite = createAfterWrite({ refresher: stack.refresher, settle: () => stack.idle(), timers: deps.timers });
  const execute = createExecutor({
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

  const uploader = createUploaderFactory({
    isBlocked,
    store: stack.store,
    native: stack.uploader,
    foreground: createForegroundUploads({ api: deps.api, readStoredBlob: createStoredBlobReader(stack.store, deps.files) }),
    onError: report,
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
    notify: (message, variant = 'info', options) => {
      try {
        deps.notify(message, variant, options);
      } catch (error) {
        report(error);
      }
    },
    reload: () => deps.onReload(),
    ...(deps.onRestart === undefined ? {} : { restartSession: () => deps.onRestart?.() }),
    openUrl: (url) => {
      let secure = false;
      try {
        secure = new URL(url).protocol === 'https:';
      } catch {
        secure = false;
      }
      if (!secure) {
        deps.notify(MESSAGES.linkBlocked, 'warning');
        return;
      }
      deps.openExternal(url).catch(report);
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
    media: { store: stack.store, uploader },
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
