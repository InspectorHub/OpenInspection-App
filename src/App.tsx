import { useEffect, useMemo, useRef, useState } from 'react';
import { boot, screenForSignedIn, type BootResult, type Screen } from './app/boot';
import { loadIdentity, type StoredIdentity } from './auth/server-config';
import type { CallbackRouter } from './app/callbacks';
import type { AppServices } from './app/compose';
import { appDiagnostics } from './app/diagnostics';
import { SWEEP_AGE_MS, sweepStaleExports } from './export/sweep';
import { createUnlockEmitter } from './app/lock-events';
import { OfflineStackContext } from './app/stack-context';
import { useOfflineStackLifecycle, type StackFactory } from './app/use-offline-stack';
import type { Network } from './platform/network';
import { startLockMonitor, realScheduler, type AppStatePort, type Scheduler } from './offline/lock-monitor';
import type { LockOutcome } from './offline/lock-state';
import { Booting, OpenFailed, SchemaDrift, SchemaTooNew } from './ui/Blocking';
import { ExportFlow } from './ui/ExportFlow';
import { Locked } from './ui/Locked';
import { ServerSetup } from './ui/ServerSetup';
import { SignedIn } from './ui/SignedIn';
import { SignIn } from './ui/SignIn';

export interface AppProps {
  /** Opens the database and secure store: `composeReal` on a device, a fake in tests. */
  open(): Promise<AppServices>;
  /** Accept plain http to a non-loopback host. Honoured in development builds only; a release build ignores it. */
  allowInsecureHttp?: boolean;
  /** Routes sign-in callbacks to the login flow once the app has opened. The listener behind it is registered at start. */
  callbacks?: CallbackRouter;
  /** Foreground and background transitions; the lock is evaluated again on every return to the foreground. */
  appState?: AppStatePort;
  /** The timer behind the 60 second lock check; defaults to the page's own. */
  scheduler?: Scheduler;
  /**
   * Builds the offline stack (sync, reconcile, media, collaboration) of a signed-in session. Called once per session when the
   * work screen appears and stopped when it goes away (sign-out, lock, another account or server). Omitted: no stack is built.
   */
  offline?: StackFactory;
  /** Link state for the editor and foreground version checks. Omitted: the editor uses browser link state. */
  network?: Network;
}

/** Consecutive failed mid-session evaluations after which the work screen is locked. */
const LOCK_FAILURES_BEFORE_CLOSING = 2;

/** Applies a lock evaluation to the current screen: only the work screens and the lock screen are affected. */
function applyOutcome(screen: Screen, outcome: LockOutcome): Screen {
  if (screen.kind !== 'signed_in' && screen.kind !== 'locked') return screen;
  if (!outcome.locked) return screen.kind === 'locked' ? { kind: 'signed_in', origin: screen.origin, identity: screen.identity } : screen;
  if (screen.kind === 'locked' && screen.reason === outcome.reason) return screen;
  return { kind: 'locked', origin: screen.origin, identity: screen.identity, reason: outcome.reason };
}

/**
 * Leaves the sign-in screen for the lock screen. The lock is evaluated again from what is stored, so a
 * revocation that no session-confirmed sign-in has cleared brings the lock screen back, never the work screen.
 */
async function backToLock(services: AppServices, origin: string, held: StoredIdentity, setScreen: (screen: Screen) => void): Promise<void> {
  let identity: StoredIdentity | null;
  try {
    identity = await loadIdentity(services.db);
  } catch {
    // The stored identity cannot be read: fail closed to the lock screen the person came from.
    setScreen({ kind: 'locked', origin, identity: held, reason: 'expired' });
    return;
  }
  if (identity === null) {
    // No identity is stored any more, so there is no lock to return to; a plain sign-in is the only way on.
    setScreen({ kind: 'sign_in', origin, relogin: false, notices: [] });
    return;
  }
  setScreen(await screenForSignedIn(services, origin, identity).catch((): Screen => ({ kind: 'locked', origin, identity, reason: 'expired' })));
}

export function App({ open, allowInsecureHttp = true, callbacks, appState, scheduler = realScheduler, offline, network }: AppProps) {
  const [services, setServices] = useState<AppServices | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'booting' });
  const [lockedExport, setLockedExport] = useState(false);
  // True while Settings removes this device's data: the verification marks go with it, so a lock check now would read "expired".
  const [wiping, setWiping] = useState(false);
  const started = useRef<Promise<BootResult> | null>(null);
  const unlocks = useMemo(() => createUnlockEmitter(), []);
  const insecure = import.meta.env.DEV && allowInsecureHttp;
  const stack = useOfflineStackLifecycle(services, offline, screen.kind === 'signed_in' ? { origin: screen.origin, identity: screen.identity } : null, insecure, unlocks.onUnlocked, appDiagnostics.push);

  useEffect(() => {
    // One open per launch, even where React runs the effect twice.
    started.current ??= boot(open, { allowInsecureHttp: import.meta.env.DEV && allowInsecureHttp });
    let current = true;
    void started.current.then((result) => {
      if (!current) return;
      setServices(result.services);
      setScreen(result.screen);
    });
    return () => {
      current = false;
    };
  }, [open, allowInsecureHttp]);

  // An export archive left in the cache holds customers' data in the clear. Archives older than the bound the export itself keeps are
  // removed at start and whenever the screen changes kind (a lock, a sign-out, a cleared device), and again on every return to the foreground.
  useEffect(() => {
    if (services) void sweepStaleExports(services.files, services.clock.now(), SWEEP_AGE_MS);
  }, [services, screen.kind]);

  useEffect(() => {
    if (!services || !appState) return undefined;
    return appState.onChange((active) => {
      if (active) void sweepStaleExports(services.files, services.clock.now(), SWEEP_AGE_MS);
    });
  }, [services, appState]);

  useEffect(() => {
    if (screen.kind !== 'locked') setLockedExport(false);
    if (screen.kind !== 'signed_in') setWiping(false);
  }, [screen.kind]);

  const flow = services?.flow;
  useEffect(() => {
    if (!callbacks || !flow) return undefined;
    return callbacks.bind(flow);
  }, [callbacks, flow]);

  const lockWatched = (screen.kind === 'signed_in' && !wiping) || screen.kind === 'locked';
  useEffect(() => {
    if (!services || !lockWatched) return undefined;
    let failures = 0;
    const monitor = startLockMonitor({
      db: services.db,
      clock: services.clock,
      scheduler,
      appState,
      onOutcome: (outcome) => {
        failures = 0;
        unlocks.note(outcome);
        setScreen((current) => applyOutcome(current, outcome));
      },
      onError: () => {
        failures += 1;
        // One transient error must not lock a working inspector; two in a row fail closed, as the sign-in path does.
        // A lock that is already showing keeps its own reason. The next good evaluation brings the work screen back.
        if (failures >= LOCK_FAILURES_BEFORE_CLOSING) setScreen((current) => (current.kind === 'signed_in' ? { kind: 'locked', origin: current.origin, identity: current.identity, reason: 'expired' } : current));
      },
    });
    return () => monitor.stop();
  }, [services, lockWatched, scheduler, appState, unlocks]);

  // The server's version policy is read again each time the app returns to the foreground (and once when a session's stack starts):
  // no timer, and a read that gets no answer changes nothing.
  const sessionOrigin = screen.kind === 'signed_in' ? screen.origin : null;
  useEffect(() => {
    if (!services || !appState || sessionOrigin === null) return undefined;
    return appState.onChange((active) => {
      if (!active) return;
      // Offline there is nothing to ask. A link state that cannot be read is not known, and unknown goes ahead.
      void (async () => {
        const online = network === undefined ? true : await network.online().catch(() => true);
        if (online) await services.refreshCompat(sessionOrigin);
      })();
    });
  }, [services, appState, sessionOrigin, network]);

  if (!services) {
    if (screen.kind === 'schema_too_new') return <SchemaTooNew />;
    if (screen.kind === 'schema_drift') return <SchemaDrift />;
    if (screen.kind === 'open_failed') return <OpenFailed reason={screen.reason} />;
    return <Booting />;
  }

  switch (screen.kind) {
    case 'setup':
      return <ServerSetup services={services} onConnected={(origin, notices) => setScreen({ kind: 'sign_in', origin, relogin: false, notices })} />;
    case 'sign_in':
      return (
        <SignIn
          services={services}
          origin={screen.origin}
          relogin={screen.relogin}
          notices={screen.notices}
          onSignedIn={(result) => {
            const identity = { userId: result.session.userId, tenantId: result.session.tenantId, role: result.session.role };
            // Fails closed: if the lock cannot be evaluated, the data stays behind the lock screen until it can.
            void screenForSignedIn(services, result.origin, identity).then(setScreen, () => setScreen({ kind: 'locked', origin: result.origin, identity, reason: 'expired' }));
          }}
          onChangeServer={() => setScreen({ kind: 'setup' })}
          onBack={
            screen.backToLock
              ? () => {
                  const held = screen.backToLock;
                  if (held) void backToLock(services, screen.origin, held, setScreen);
                }
              : undefined
          }
        />
      );
    case 'signed_in':
      return (
        <OfflineStackContext.Provider value={stack}>
          <SignedIn
            services={services}
            origin={screen.origin}
            identity={screen.identity}
            onSignedOut={() => setScreen({ kind: 'sign_in', origin: screen.origin, relogin: false, notices: [] })}
            onWiping={setWiping}
            {...(network === undefined ? {} : { network })}
          />
        </OfflineStackContext.Provider>
      );
    case 'locked':
      return (
        <>
        <Locked
          services={services}
          origin={screen.origin}
          reason={screen.reason}
          onOutcome={(outcome) => {
            unlocks.note(outcome);
            setScreen((current) => applyOutcome(current, outcome));
          }}
          onSignInRequired={() => setScreen({ kind: 'sign_in', origin: screen.origin, relogin: true, notices: [], backToLock: screen.identity })}
          onCleared={() => setScreen({ kind: 'sign_in', origin: screen.origin, relogin: false, notices: [] })}
          onExport={() => setLockedExport(true)}
          onSignedOut={() => setScreen({ kind: 'sign_in', origin: screen.origin, relogin: false, notices: [] })}
        />
        {lockedExport && <ExportFlow services={services} onClose={() => setLockedExport(false)} />}
        </>
      );
    default:
      return <Booting />;
  }
}
