import { useEffect, useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { clearLocalData } from '../offline/clear-local-data';
import type { LockReason } from '../offline/lock';
import { loadTenantName, type LockOutcome } from '../offline/lock-state';
import { verifyOnline } from '../offline/verify-online';
import { countWaitingUploads } from '../offline/waiting';
import { ConfirmDialog } from './ConfirmDialog';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { useActionLatch } from './latch';

export interface LockedProps {
  services: AppServices;
  origin: string;
  reason: LockReason;
  /** The lock was evaluated again (after "Verify online"): unlocked, or locked for this or another reason. */
  onOutcome(outcome: LockOutcome): void;
  /** The server refused the sign-in while verifying. Local data is untouched. */
  onSignInRequired(): void;
  /** Local data was cleared; the person can sign in again to the same server. */
  onCleared(): void;
  /**
   * Hands the unsent data to the export. The button is shown only when this is supplied, so the screen
   * never offers an action the app cannot perform.
   */
  onExport?(): void;
}

const HEADINGS: Record<LockReason, string> = {
  expired: 'Verification needed',
  clock: 'Check your date and time',
  revoked: 'This device can no longer upload',
};

const FALLBACK_COMPANY = 'your company';

const CLEAR_DESCRIPTION =
  'This permanently removes the inspections, photos and changes that have not been uploaded from this device. This cannot be undone.';

const CLOCK_STILL_BEHIND =
  'Your date and time are still earlier than the app has already seen. Correct them in your device settings, then verify again.';

function reasonText(reason: LockReason, company: string): string {
  switch (reason) {
    case 'expired':
      return 'This device has been offline longer than your company allows. Connect to the internet and verify to keep working. Nothing on this device has been deleted.';
    case 'clock':
      return 'The date or time on this device is earlier than the app has already seen. Correct them in your device settings, then verify online. Nothing on this device has been deleted.';
    case 'revoked':
      return `This data belongs to ${company}. Export it and give it to your company, or clear it from this device.`;
  }
}

/** "1 item" / "3 items". */
function items(count: number): string {
  return `${String(count)} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * Shown instead of the work screens when the offline period, the clock or a revocation says the local
 * data must stay closed. It offers only what is true for the reason: verifying online (expired, clock),
 * exporting (when the app can), and clearing the device. Nothing here deletes anything on its own.
 */
export function Locked({ services, origin, reason, onOutcome, onSignInRequired, onCleared, onExport }: LockedProps) {
  const [waiting, setWaiting] = useState<number | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [leftover, setLeftover] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latch = useActionLatch();

  useEffect(() => {
    let current = true;
    void Promise.all([countWaitingUploads(services.db), loadTenantName(services.db)]).then(
      ([count, name]) => {
        if (!current) return;
        setWaiting(count);
        setCompany(name);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [services.db, reason]);

  async function verify(): Promise<void> {
    setNotice(null);
    setVerifying(true);
    try {
      const result = await verifyOnline(services, origin);
      switch (result.kind) {
        case 'unlocked':
          onOutcome({ locked: false });
          return;
        case 'locked':
          if (result.reason === 'clock') setNotice(CLOCK_STILL_BEHIND);
          onOutcome({ locked: true, reason: result.reason });
          break;
        case 'sign_in_required':
          onSignInRequired();
          return;
        case 'retry':
          setNotice(result.cause === 'offline' ? 'Could not reach the server. Check your connection and try again.' : 'The server could not verify this device right now. Try again in a moment.');
          break;
      }
    } catch {
      setNotice('Verification did not finish. Try again.');
    }
    setVerifying(false);
  }

  async function clear(): Promise<void> {
    setClearError(null);
    setClearing(true);
    try {
      const result = await clearLocalData(services.db, services.files);
      await services.tokens.signOut(origin).catch(() => undefined);
      if (result.filesFailed.length > 0) {
        setConfirming(false);
        setLeftover(result.filesFailed.length);
        setClearing(false);
        return;
      }
      onCleared();
    } catch {
      setClearError('Local data could not be cleared. Try again.');
      setClearing(false);
    }
  }

  function closeDialog(): void {
    setConfirming(false);
    setClearError(null);
    trigger.current?.focus();
  }

  if (leftover !== null) {
    return (
      <Screen>
        <Heading>Local data cleared</Heading>
        <Notice tone="watch">{`${items(leftover)} could not be removed from this device's storage. The records are gone, but ${leftover === 1 ? 'a photo file' : 'some photo files'} may remain until the app is uninstalled.`}</Notice>
        <Button onClick={onCleared}>Continue</Button>
      </Screen>
    );
  }

  const canVerify = reason !== 'revoked';
  return (
    <Screen>
      <Heading>{HEADINGS[reason]}</Heading>
      <Body>{reasonText(reason, company ?? FALLBACK_COMPANY)}</Body>
      {waiting !== null && (
        <p data-testid="waiting-count" className="text-base font-semibold text-ih-fg-1">
          {reason === 'revoked' ? `${items(waiting)} on this device ${waiting === 1 ? 'was' : 'were'} not uploaded` : `${items(waiting)} waiting to upload`}
        </p>
      )}
      {notice && <Notice tone="bad">{notice}</Notice>}
      <div className="flex flex-col gap-3">
        {canVerify && (
          <Button busy={verifying} onClick={() => void latch(verify)}>
            Verify online
          </Button>
        )}
        {onExport && (
          <Button variant="secondary" disabled={verifying} onClick={onExport}>
            Export unsent data
          </Button>
        )}
        <Button ref={trigger} variant="secondary" disabled={verifying} onClick={() => setConfirming(true)}>
          Clear local data
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Clear local data?"
          description={CLEAR_DESCRIPTION}
          confirmLabel="Clear local data"
          busy={clearing}
          error={clearError}
          onConfirm={() => void latch(clear)}
          onCancel={closeDialog}
        />
      )}
    </Screen>
  );
}
