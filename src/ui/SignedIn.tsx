import { useState } from 'react';
import type { AppServices } from '../app/compose';
import type { StoredIdentity } from '../auth/server-config';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { useActionLatch } from './latch';
import { messageFor } from './messages';

export interface SignedInProps {
  services: AppServices;
  origin: string;
  identity: StoredIdentity;
  onSignedOut(): void;
}

/** Placeholder home until the work list exists; it already carries the sign-out contract. */
export function SignedIn({ services, origin, identity, onSignedOut }: SignedInProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latch = useActionLatch();

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

  return (
    <Screen>
      <Heading>Work list coming in a later task</Heading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">Role</dt>
        <dd data-testid="identity-role" className="text-ih-fg-1">
          {identity.role}
        </dd>
        <dt className="text-ih-fg-3">Company</dt>
        <dd data-testid="identity-tenant" className="break-all font-ih-mono text-sm text-ih-fg-1">
          {identity.tenantId}
        </dd>
        <dt className="text-ih-fg-3">Server</dt>
        <dd className="break-all font-ih-mono text-sm text-ih-fg-1">{origin}</dd>
      </dl>
      <Body>Signing out removes your sign-in from this device. Inspections, photos and anything not yet uploaded stay on the device.</Body>
      {error && <Notice tone="bad">{error}</Notice>}
      <Button variant="secondary" disabled={busy} onClick={() => void latch(signOut)}>
        Sign out
      </Button>
    </Screen>
  );
}
