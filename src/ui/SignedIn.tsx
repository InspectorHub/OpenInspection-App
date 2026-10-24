import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
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

interface ConfirmDialogProps {
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onCancel(): void;
}

/** A modal that asks before the sign-out: Cancel has focus, Escape and Cancel close it, Tab stays inside. */
function SignOutDialog({ busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = confirmRef.current;
    const last = cancelRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ih-bg-app/80 p-4 md:items-center" onKeyDown={onKeyDown}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex w-full max-w-md flex-col gap-4 rounded-ih-modal border border-ih-border bg-ih-bg-card p-6 shadow-ih-popover"
      >
        <h2 id={titleId} className="font-ih-display text-xl font-bold tracking-tight text-ih-fg-1">
          Sign out of this device?
        </h2>
        <p id={descriptionId} className="text-base leading-relaxed text-ih-fg-2">
          Your inspections, photos and anything not yet uploaded stay on this device. To sign in again you need a network connection, so do not sign out while you are offline unless you have to.
        </p>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex flex-col gap-3">
          <Button ref={confirmRef} disabled={busy} onClick={onConfirm}>
            Sign out
          </Button>
          <Button ref={cancelRef} variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Placeholder home until the work list exists; it already carries the sign-out contract. */
export function SignedIn({ services, origin, identity, onSignedOut }: SignedInProps) {
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
    <Screen>
      <Heading>Work list coming in a later task</Heading>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
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
      {confirming && <SignOutDialog busy={busy} error={error} onConfirm={() => void latch(signOut)} onCancel={close} />}
    </Screen>
  );
}
