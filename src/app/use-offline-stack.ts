import { useEffect, useRef, useState } from 'react';
import type { StoredIdentity } from '../auth/server-config';
import type { AppServices } from './compose';
import type { OfflineStack, StackDiagnostic } from './offline-stack';

/** What a factory needs to build the stack of one signed-in session. */
export interface StackFactoryInput {
  services: AppServices;
  /** The stored, canonical server origin of the session. */
  origin: string;
  /** The stored identity of the session. */
  identity: StoredIdentity;
  allowInsecureHttp: boolean;
  onUnlocked(listener: () => void): () => void;
}

export type StackFactory = (input: StackFactoryInput) => OfflineStack;

export interface SessionKey {
  origin: string;
  identity: StoredIdentity;
}

interface Held {
  key: string;
  stack: OfflineStack;
  users: number;
}

/**
 * Builds the stack when the signed-in screen appears and ends it when the screen goes away (sign-out, lock, a different
 * account or server). `session` is null on every other screen. React may run an effect, clean it up and run it again for
 * the same mount (StrictMode); the stop is therefore deferred one microtask, and a re-run in between keeps the same
 * stack, so one session builds one stack.
 */
export function useOfflineStackLifecycle(services: AppServices | null, factory: StackFactory | undefined, session: SessionKey | null, allowInsecureHttp: boolean, onUnlocked: (listener: () => void) => () => void, onDiagnostic?: (code: StackDiagnostic) => void): OfflineStack | null {
  const [stack, setStack] = useState<OfflineStack | null>(null);
  const held = useRef<Held | null>(null);
  // Read when a factory fails; not an effect input, so a caller passing a new function every render does not restart anything.
  const diagnostic = useRef(onDiagnostic);
  diagnostic.current = onDiagnostic;
  const origin = session?.origin ?? null;
  const tenantId = session?.identity.tenantId ?? null;
  const userId = session?.identity.userId ?? null;
  const role = session?.identity.role ?? null;

  useEffect(() => {
    if (!services || !factory || origin === null || tenantId === null || userId === null || role === null) return undefined;
    // One session is one server, one company and one user: any of them changing is another session.
    const key = JSON.stringify([origin, tenantId, userId, role]);
    let mine = held.current;
    if (mine?.key !== key || mine.stack.isStopped()) {
      let built: OfflineStack;
      try {
        built = factory({ services, origin, identity: { tenantId, userId, role }, allowInsecureHttp, onUnlocked });
        built.start();
      } catch {
        // A stack that cannot be built must not blank the app: the screen runs without offline support, and a fixed code says why.
        held.current = null;
        try {
          diagnostic.current?.('factory_failed');
        } catch {
          // A failing reporter changes nothing.
        }
        return undefined;
      }
      mine = { key, stack: built, users: 0 };
      held.current = mine;
    }
    const claim = mine;
    claim.users += 1;
    setStack(claim.stack);
    return () => {
      claim.users -= 1;
      void Promise.resolve().then(() => {
        if (claim.users > 0) return;
        if (held.current === claim) held.current = null;
        void claim.stack.stop();
        setStack((current) => (current === claim.stack ? null : current));
      });
    };
  }, [services, factory, origin, tenantId, userId, role, allowInsecureHttp, onUnlocked]);

  return session === null ? null : stack;
}
