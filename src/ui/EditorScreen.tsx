import { useEffect, useRef, useState } from 'react';
import { FieldDataSourceProvider, FieldEditor, escapeWillBeHandled, type EditorData, type FieldDataSource, type FieldHostSlots } from '@inspectorhub/field-ui';
import { clientPolicy } from '../app/client-state';
import type { AppServices } from '../app/compose';
import { editorPorts } from '../app/editor-ports';
import type { OfflineStack } from '../app/offline-stack';
import { useClientState } from '../app/use-client-state';
import { realTimers, type TimerPort } from '../collab/timers';
import { createApiClient } from '../field/api-client';
import { EditorLoadError } from '../field/editor-data';
import { editorRegistry, type EditorRegistry } from '../field/editor-registry';
import { createLocalDataSource } from '../field/local-data-source';
import { MESSAGES } from '../field/messages';
import { openNetworkFlag } from '../field/network-flag';
import { loadSessionInfo } from '../field/session-info';
import { createRealNetwork, type Network } from '../platform/network';
import { useToasts } from './EditorToasts';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { useBackHandler } from './use-back-handler';

/** What the editor screen reads of the app's services. */
export type EditorServices = Pick<AppServices, 'http' | 'tokens' | 'files' | 'clock' | 'platform' | 'appVersion' | 'openExternal' | 'clientState'>;

export interface EditorScreenProps {
  services: EditorServices;
  /** The live offline stack of the signed-in session. */
  stack: OfflineStack;
  /** The stored, canonical server origin. */
  origin: string;
  inspectionId: string;
  /** Leaves the editor for the work list. */
  onExit(): void;
  /** Link state for the editor's own online checks. Defaults to the device's. */
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
 * Shown while a required update turns editing off. What is refused today: commands, uploads and media saves (the data source
 * checks `canEdit`). Edits to ratings and notes in the shared document are not blocked in this build; field-ui has no read-only
 * mode yet, and a `readOnly` prop is planned for it. The wording claims only what is enforced.
 */
export const READ_ONLY_NOTICE = 'Some actions are turned off until you update the app. You can still read this inspection.';

const SLOTS: FieldHostSlots = { humanCheck: 'not-required' };

type Phase = { kind: 'loading' } | { kind: 'ready'; source: FieldDataSource; data: EditorData } | { kind: 'failed'; message: string };

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

  // The back chain sends Escape first. If an editor layer will still answer one, the press is theirs and stays on this page;
  // otherwise it leaves. (A layer that is open but does not answer Escape does not trap the person.)
  useBackHandler(() => {
    if (escapeWillBeHandled()) return true;
    leave.current();
    return true;
  });

  useEffect(() => {
    let live = true;
    const release = registry.register(inspectionId);
    const flag = openNetworkFlag(network ?? createRealNetwork(), { timers });
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
        const source: FieldDataSource = createLocalDataSource({
          stack,
          api,
          files: services.files,
          network: flag,
          registry,
          session,
          origin,
          canEdit: ports.canEdit,
          platform: services.platform,
          signedAtMs: () => services.clock.now(),
          clock: services.clock,
          timers,
          notify: (message, variant, options) => notify.current(message, variant, options),
          openExternal: services.openExternal,
          onExit: () => leave.current(),
          onReload: () => {
            source.load(inspectionId).then(
              (data) => {
                if (live) setPhase({ kind: 'ready', source, data });
              },
              (error: unknown) => {
                if (live) setPhase({ kind: 'failed', message: messageOf(error) });
              },
            );
          },
          onRestart: () => restart.current(),
        });
        const data = await source.load(inspectionId);
        if (live) setPhase({ kind: 'ready', source, data });
      } catch (error) {
        if (live) setPhase({ kind: 'failed', message: messageOf(error) });
      }
    })();
    return () => {
      live = false;
      stopEvents();
      flag.dispose();
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
  return (
    <>
      {!canEdit && (
        <div className="px-4 pt-[max(0.5rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]">
          <Notice tone="watch">{READ_ONLY_NOTICE}</Notice>
        </div>
      )}
      <FieldDataSourceProvider dataSource={phase.source} slots={SLOTS}>
        <FieldEditor data={phase.data} />
      </FieldDataSourceProvider>
      {toasts.view}
    </>
  );
}
