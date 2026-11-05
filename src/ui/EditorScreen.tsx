import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { FieldDataSourceProvider, FieldEditor, escapeWillBeHandled, type EditorData, type FieldDataSource, type FieldHostSlots } from '@inspectorhub/field-ui';
import { clientPolicy } from '../app/client-state';
import type { AppServices } from '../app/compose';
import { appDiagnostics } from '../app/diagnostics';
import { editorPorts } from '../app/editor-ports';
import type { OfflineStack } from '../app/offline-stack';
import { useClientState } from '../app/use-client-state';
import { realTimers, type TimerPort } from '../collab/timers';
import { createAfterWrite } from '../field/after-write';
import { createApiClient } from '../field/api-client';
import { EditorLoadError, NO_REPORT_LOCK, loadReportLock, type ReportLock } from '../field/editor-data';
import { editorRegistry, type EditorRegistry } from '../field/editor-registry';
import { createLocalDataSource } from '../field/local-data-source';
import { MESSAGES } from '../field/messages';
import { openNetworkFlag } from '../field/network-flag';
import { reopenReport, type ReopenOutcome } from '../field/reopen-report';
import { createPhotoCache, type PhotoCache } from '../field/photo-cache';
import { createUploadedCopyReader } from '../field/photo-urls';
import { loadSessionInfo } from '../field/session-info';
import type { Network } from '../platform/network';
import { createGalleryCopier } from '../field/gallery-copy';
import { useToasts } from './EditorToasts';
import { editorObserver } from './editor-observer';
import { EditorStatus } from './EditorStatus';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { PublishedReportBanner } from './PublishedReportBanner';
import { useOnline } from './worklist/useOnline';
import { useBackHandler } from './use-back-handler';

/** What the editor screen reads of the app's services. */
export type EditorServices = Pick<AppServices, 'http' | 'tokens' | 'files' | 'clock' | 'platform' | 'appVersion' | 'openExternal' | 'clientState' | 'decodeImage' | 'photoGallery' | 'gallerySetting'>;

export interface EditorScreenProps {
  services: EditorServices;
  /** The live offline stack of the signed-in session. */
  stack: OfflineStack;
  /** The stored, canonical server origin. */
  origin: string;
  inspectionId: string;
  /** Leaves the editor for the work list. */
  onExit(): void;
  /** Link state for the editor's own online checks. Defaults to the browser's. */
  network?: Network;
  timers?: TimerPort;
  registry?: EditorRegistry;
}

/**
 * The app has no human-verification step, by the owner's decision: it publishes as a signed-in inspector on an authenticated
 * session, not an anonymous surface, and the server decides what the Bearer token may publish. The slot is written down on
 * purpose; leaving it out would refuse every publish.
 */
/**
 * Shown while a required update turns editing off. The editor itself is then read-only (`readOnly` on `FieldEditor`: no document
 * writes, no host writes, write controls hidden); the data source also refuses commands, uploads and media saves as defence in depth.
 */
export const READ_ONLY_NOTICE = 'Some actions are turned off until you update the app. You can still read this inspection.';


/** Browser link state only; this does not check whether the server is reachable. */
const browserNetwork: Network = {
  online: async () => navigator.onLine,
  onChange: (cb) => {
    const notify = () => cb(navigator.onLine);
    window.addEventListener('online', notify);
    window.addEventListener('offline', notify);
    return () => {
      window.removeEventListener('online', notify);
      window.removeEventListener('offline', notify);
    };
  },
};

type Phase = { kind: 'loading' } | { kind: 'ready'; source: FieldDataSource; data: EditorData; lock: ReportLock } | { kind: 'failed'; message: string };

/**
 * The banner of a published report, as the editor's slot shows it. It holds the state of the "Edit and republish" request itself:
 * on success the whole editor session starts again so it reads the report as the server now has it.
 */
function ReopenBanner({ lockRef, serverLocked, openPublish, reopen, onReopened, network }: {
  lockRef: MutableRefObject<ReportLock>;
  serverLocked: boolean;
  openPublish(): void;
  reopen: MutableRefObject<(() => Promise<ReopenOutcome>) | null>;
  onReopened(): void;
  network: Network | undefined;
}) {
  const online = useOnline(network) !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editAgain = (): void => {
    const run = reopen.current;
    if (run === null || busy) return;
    setBusy(true);
    setError(null);
    void run().then(
      (outcome) => {
        setBusy(false);
        if (!outcome.ok) setError(outcome.error);
        else if (!outcome.cacheCurrent) setError(MESSAGES.reopenNotCurrent);
        else onReopened();
      },
      () => {
        setBusy(false);
        setError(MESSAGES.reopenFailed);
      },
    );
  };
  return <PublishedReportBanner lock={lockRef.current} serverLocked={serverLocked} online={online} busy={busy} error={error} onEditAgain={editAgain} onPublish={openPublish} />;
}

const messageOf = (error: unknown): string => (error instanceof EditorLoadError ? error.message : MESSAGES.unavailable);

/**
 * The inspection editor of field-ui over the device's own data source. Android's back key closes the editor's open dialogs
 * first, then leaves for the work list (the app leaves only from the list). The screen restarts from a clean mount when the
 * editor asks for it, and leaves by itself when its inspection is removed or put in quarantine.
 */
export function EditorScreen(props: EditorScreenProps) {
  const [epoch, setEpoch] = useState(0);
  return <EditorSession key={epoch} {...props} onRestart={() => setEpoch((n) => n + 1)} />;
}

/** The cache folder is swept for orphans once per run of the app, not at every editor open. */
let orphansSwept = false;

function EditorSession({ services, stack, origin, inspectionId, onExit, onRestart, network, timers = realTimers, registry = editorRegistry }: EditorScreenProps & { onRestart(): void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const toasts = useToasts(timers);
  const state = useClientState(services.clientState);
  const canEdit = clientPolicy(state, origin).canEdit;
  const leave = useRef(onExit);
  leave.current = onExit;
  const notify = useRef(toasts.push);
  notify.current = toasts.push;
  const restart = useRef(onRestart);
  restart.current = onRestart;
  // The report's lock as of the last load, and the "Edit and republish" request (set once the session has an api client).
  const lockRef = useRef<ReportLock>(NO_REPORT_LOCK);
  const reopen = useRef<(() => Promise<ReopenOutcome>) | null>(null);
  // One slot object per session, so the editor does not see a new one on every render. The status chip reads its own state.
  const slots = useMemo<FieldHostSlots>(
    () => ({
      humanCheck: 'not-required',
      renderStatus: () => <EditorStatus db={stack.db} status={stack.status} network={network} timers={timers} />,
      renderPublishBanner: ({ openPublish, locked }) => (
        <ReopenBanner lockRef={lockRef} serverLocked={locked} openPublish={openPublish} reopen={reopen} onReopened={() => restart.current()} network={network} />
      ),
    }),
    [stack, network, timers],
  );

  // The back chain sends Escape first. If an editor layer will still answer one, the press is theirs and stays on this page;
  // otherwise it leaves. (A layer that is open but does not answer Escape does not trap the person.)
  useBackHandler(() => {
    if (escapeWillBeHandled()) return true;
    leave.current();
    return true;
  });

  useEffect(() => {
    let live = true;
    let photoCache: PhotoCache | undefined;
    const release = registry.register(inspectionId);
    const flag = openNetworkFlag(network ?? browserNetwork, { timers });
    const observation = editorObserver.current()?.({ isOnline: flag.isOnline, hasLiveDoc: () => registry.liveDoc(inspectionId) !== null, readOnly: !canEdit });
    const stopEvents = stack.onEditorEvent((event) => {
      if (event.inspectionId === inspectionId && event.kind !== 'unquarantined') leave.current();
    });
    void (async () => {
      try {
        const session = await loadSessionInfo(stack.db, stack.account);
        const ports = editorPorts(services, stack, origin);
        const api = createApiClient({
          http: services.http,
          tokens: services.tokens,
          origin,
          clientHeaders: { 'X-Client-Platform': services.platform, 'X-Client-Version': services.appVersion },
          gate: ports.api.gate,
          serverTooOld: ports.api.serverTooOld,
        });
        // Copies of server photos, so a thumbnail whose file left the device still shows (and shows offline once seen).
        photoCache = createPhotoCache({
          db: stack.db,
          files: services.files,
          api,
          account: stack.account,
          network: flag,
          clock: services.clock,
          timers,
          localCopy: createUploadedCopyReader(stack.store, services.files),
        });
        // "Edit and republish": the server opens the report, then this inspection is downloaded again like after any online write.
        const afterWrite = createAfterWrite({ refresher: stack.refresher, settle: () => stack.idle(), timers });
        reopen.current = () => reopenReport({ api, isOnline: flag.isOnline, afterWrite }, inspectionId);
        if (!live) photoCache.dispose();
        else if (!orphansSwept) {
          // Once per run of the app: files a crash left without a row.
          orphansSwept = true;
          void photoCache.sweepOrphans();
        }
        const source: FieldDataSource = createLocalDataSource({
          stack,
          api,
          photoCache,
          isClosed: () => !live,
          files: services.files,
          ...(services.decodeImage === undefined ? {} : { decodeImage: services.decodeImage }),
          network: flag,
          registry,
          session,
          origin,
          canEdit: ports.canEdit,
          onDiagnostic: appDiagnostics.push,
          copyToGallery: createGalleryCopier({ setting: services.gallerySetting, gallery: services.photoGallery }),
          platform: services.platform,
          signedAtMs: () => services.clock.now(),
          clock: services.clock,
          timers,
          notify: (message, variant, options) => {
            observation?.notified(message, variant);
            notify.current(message, variant, options);
          },
          openExternal: services.openExternal,
          onExit: () => leave.current(),
          onReload: () => {
            source.load(inspectionId).then(
              async (data) => {
                const lock = await loadReportLock({ db: stack.db, account: stack.account }, inspectionId);
                if (live) setPhase({ kind: 'ready', source, data, lock });
              },
              (error: unknown) => {
                if (live) setPhase({ kind: 'failed', message: messageOf(error) });
              },
            );
          },
          onRestart: () => restart.current(),
        });
        observation?.attach(source);
        const data = await source.load(inspectionId);
        const lock = await loadReportLock({ db: stack.db, account: stack.account }, inspectionId);
        if (live) setPhase({ kind: 'ready', source, data, lock });
      } catch (error) {
        if (live) setPhase({ kind: 'failed', message: messageOf(error) });
      }
    })();
    return () => {
      live = false;
      // Drops downloads still in flight so they cannot write after the editor is left or the account is signed out.
      photoCache?.dispose();
      stopEvents();
      flag.dispose();
      observation?.dispose();
      release();
    };
  }, [services, stack, origin, inspectionId, network, timers, registry]);

  if (phase.kind === 'loading') {
    return (
      <Screen>
        <div role="status" aria-busy="true">
          <Body>Opening the inspection…</Body>
        </div>
      </Screen>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <Screen>
        <Heading>Inspection</Heading>
        <Notice tone="bad">{phase.message}</Notice>
        <Button variant="secondary" onClick={() => leave.current()}>
          Back to work list
        </Button>
      </Screen>
    );
  }
  // A published report opens for reading only, whatever the account may do: the server refuses every content write until it is reopened.
  lockRef.current = phase.lock;
  const readOnly = !canEdit || phase.lock.contentLocked;
  return (
    <>
      {!canEdit && (
        <div className="px-4 pt-[max(0.5rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]">
          <Notice tone="watch">{READ_ONLY_NOTICE}</Notice>
        </div>
      )}
      <FieldDataSourceProvider dataSource={phase.source} slots={slots}>
        <FieldEditor data={phase.data} readOnly={readOnly} />
      </FieldDataSourceProvider>
      {toasts.view}
    </>
  );
}
