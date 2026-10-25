import { useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { useOfflineStack } from '../app/stack-context';
import type { StoredIdentity } from '../auth/server-config';
import { ConfirmDialog } from './ConfirmDialog';
import { DevDiagnostics } from './dev-diagnostics';
import { Body, Button, Heading, Screen } from './kit';
import { useActionLatch } from './latch';
import { messageFor } from './messages';
import { WorkList } from './WorkList';

export interface SignedInProps {
  services: AppServices;
  origin: string;
  identity: StoredIdentity;
  onSignedOut(): void;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  inspector: 'Inspector',
};

const UNKNOWN_ROLE_LABEL = 'Team member';

/** The role is server-supplied text; only a fixed label of ours ever reaches the screen. */
export function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? (ROLE_LABELS[role] ?? UNKNOWN_ROLE_LABEL) : UNKNOWN_ROLE_LABEL;
}

/** The home of a signed-in device: the work list (where there is an offline stack), the account, and the sign-out contract. */
export function SignedIn({ services, origin, identity, onSignedOut }: SignedInProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latch = useActionLatch();
  const stack = useOfflineStack();

  async function signOut(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await services.tokens.signOut(origin);
      onSignedOut();
    } catch (err) {
      setError(messageFor(err, 'storage_failed'));
      setBusy(false);
    }
  }

  function close(): void {
    setConfirming(false);
    setError(null);
    trigger.current?.focus();
  }

  return (
    <Screen wide={stack !== null}>
      {stack === null ? <Heading>Work list</Heading> : <WorkList stack={stack} />}
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">Role</dt>
        <dd data-testid="identity-role" className="text-ih-fg-1">
          {roleLabel(identity.role)}
        </dd>
        <dt className="text-ih-fg-3">Server</dt>
        <dd className="break-all font-ih-mono text-sm text-ih-fg-1">{origin}</dd>
      </dl>
      <Body>Signing out removes your sign-in from this device. Inspections, photos and anything not yet uploaded stay on the device.</Body>
      <Button ref={trigger} variant="secondary" onClick={() => setConfirming(true)}>
        Sign out
      </Button>
      <DevDiagnostics services={services} origin={origin} />
      {confirming && (
        <ConfirmDialog
          title="Sign out of this device?"
          description="Your inspections, photos and anything not yet uploaded stay on this device. To sign in again you need a network connection, so do not sign out while you are offline unless you have to."
          confirmLabel="Sign out"
          busy={busy}
          error={error}
          onConfirm={() => void latch(signOut)}
          onCancel={close}
        />
      )}
    </Screen>
  );
}
