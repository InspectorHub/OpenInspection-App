import { useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { haptic } from '../platform/haptics';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './kit';
import { useActionLatch } from './latch';
import { messageFor } from './messages';

export interface SignOutControlProps {
  services: Pick<AppServices, 'tokens'>;
  origin: string;
  onSignedOut(): void;
}

/**
 * The Sign out button and the question behind it. Signing out removes the sign-in from this device and nothing else: the
 * inspections, photos and anything not yet uploaded stay. The same control is used on the home screen, in Settings and on the
 * lock screen, so the wording and the behaviour cannot drift.
 */
export function SignOutControl({ services, origin, onSignedOut }: SignOutControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latch = useActionLatch();

  async function signOut(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await services.tokens.signOut(origin);
      haptic('success');
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
    <>
      <Button ref={trigger} variant="secondary" onClick={() => setConfirming(true)}>
        Sign out
      </Button>
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
    </>
  );
}
