import { useEffect, useRef, useState } from 'react';
import { boot, type BootResult, type Screen } from './app/boot';
import type { CallbackRouter } from './app/callbacks';
import type { AppServices } from './app/compose';
import { Booting, OpenFailed, SchemaTooNew } from './ui/Blocking';
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
}

export function App({ open, allowInsecureHttp = true, callbacks }: AppProps) {
  const [services, setServices] = useState<AppServices | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'booting' });
  const started = useRef<Promise<BootResult> | null>(null);

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

  const flow = services?.flow;
  useEffect(() => {
    if (!callbacks || !flow) return undefined;
    return callbacks.bind(flow);
  }, [callbacks, flow]);

  if (!services) {
    if (screen.kind === 'schema_too_new') return <SchemaTooNew />;
    if (screen.kind === 'open_failed') return <OpenFailed />;
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
          onSignedIn={(result) =>
            setScreen({
              kind: 'signed_in',
              origin: result.origin,
              identity: { userId: result.session.userId, tenantId: result.session.tenantId, role: result.session.role },
            })
          }
          onChangeServer={() => setScreen({ kind: 'setup' })}
        />
      );
    case 'signed_in':
      return (
        <SignedIn
          services={services}
          origin={screen.origin}
          identity={screen.identity}
          onSignedOut={() => setScreen({ kind: 'sign_in', origin: screen.origin, relogin: false, notices: [] })}
        />
      );
    default:
      return <Booting />;
  }
}
