import { useEffect, useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { countAtRisk, type AtRisk } from '../offline/at-risk';
import { clearLocalData } from '../offline/clear-local-data';
import type { LockReason } from '../offline/lock';
import { loadTenantName, type LockOutcome } from '../offline/lock-state';
import { verifyOnline } from '../offline/verify-online';
import { countWaitingUploads } from '../offline/waiting';
import { atRiskLines, COUNT_UNKNOWN } from './ClearLocalDataControl';
import { ConfirmDialog } from './ConfirmDialog';
import { BuildExpiry } from './BuildExpiry';
import { Body, Button, Heading, Notice, Screen } from './kit';
import { useActionLatch } from './latch';
import { SignOutControl } from './SignOutControl';

export interface LockedProps {
  services: AppServices;
  origin: string;
  reason: LockReason;
  /** The lock was evaluated again (after "Verify online"): unlocked, or locked for this or another reason. */
  onOutcome(outcome: LockOutcome): void;
  /** The person chose to sign in again, or the server refused the session while verifying. Local data is untouched. */
  onSignInRequired(): void;
  /** Local data was cleared; the person can sign in again to the same server. */
  onCleared(): void;
  /**
   * Hands the unsent data to the export. The button is shown only when this is supplied, so the screen
   * never offers an action the app cannot perform.
   */
  onExport?(): void;
  /** The person signed out from the lock screen. Local data is untouched. The button is shown only when this is supplied. */
  onSignedOut?(): void;
}

const HEADINGS: Record<LockReason, string> = {
  expired: 'Verification needed',
  clock: 'Check your date and time',
  revoked: 'This device can no longer upload',
};

const FALLBACK_COMPANY = 'your company';

const CLEAR_DESCRIPTION =
  'This permanently removes the inspections, photos and changes that have not been uploaded from this device. This cannot be undone.';

const SECOND_DESCRIPTION = 'These items exist only on this device. Once removed they cannot be recovered. Export them first if you may need them.';

const CLOCK_STILL_BEHIND =
  'Your date or time still looks wrong to the app or the server. Correct them in your device settings, then verify again.';

function reasonText(reason: LockReason, company: string): string {
  switch (reason) {
    case 'expired':
      return 'This device has been offline longer than your company allows. Connect to the internet and verify to keep working. Nothing on this device has been deleted.';
    case 'clock':
      return 'The date or time on this device does not match what the app has already seen. Correct them in your device settings (automatic date and time works best). Until the clock is right the app stays locked. Once it is right, verifying online can then re-check it when the server supports it. Nothing on this device has been deleted.';
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
export function Locked({ services, origin, reason, onOutcome, onSignInRequired, onCleared, onExport, onSignedOut }: LockedProps) {
  const [waiting, setWaiting] = useState<number | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<'closed' | 'first' | 'second'>('closed');
  /** What the count found when the first question was confirmed; null when the count failed. */
  const [risk, setRisk] = useState<AtRisk | null>(null);
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

  /**
   * The first confirmation. What would be lost is counted right now; when anything has not reached the server (or the count
   * cannot be made) the person is asked a second time with the count in front of them, and nothing is removed yet.
   */
  async function advance(): Promise<void> {
    setClearError(null);
    setClearing(true);
    let fresh: AtRisk | null = null;
    try {
      fresh = await countAtRisk(services.db);
    } catch {
      fresh = null;
    }
    if (fresh === null || fresh.total > 0) {
      setRisk(fresh);
      setStep('second');
      setClearing(false);
      return;
    }
    await clear();
  }

  async function clear(): Promise<void> {
    setClearError(null);
    setClearing(true);
    try {
      const result = await clearLocalData(services.db, services.files, services.clock.now());
      await services.tokens.signOut(origin).catch(() => undefined);
      if (result.filesFailed.length > 0) {
        setStep('closed');
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
    setStep('closed');
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
      <BuildExpiry services={services} />
      <Body>{reasonText(reason, company ?? FALLBACK_COMPANY)}</Body>
      {waiting !== null && (
        <p data-testid="waiting-count" className="text-base font-semibold text-ih-fg-1">
          {reason === 'revoked' ? `${items(waiting)} on this device ${waiting === 1 ? 'was' : 'were'} not uploaded` : `${items(waiting)} waiting to upload`}
        </p>
      )}
      {reason === 'revoked' && <Body>Signed out by mistake? Sign in again with the same account to keep working with this data.</Body>}
      {notice && <Notice tone="bad">{notice}</Notice>}
      <div className="flex flex-col gap-3">
        {reason === 'revoked' && (
          <Button
            disabled={verifying}
            onClick={() =>
              void latch(() => {
                try {
                  onSignInRequired();
                } catch {
                  setNotice('Could not open sign-in. Try again.');
                }
                return Promise.resolve();
              })
            }
          >
            Sign in again
          </Button>
        )}
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
        <Button ref={trigger} variant="secondary" disabled={verifying} onClick={() => setStep('first')}>
          Clear local data
        </Button>
        {onSignedOut && <SignOutControl services={services} origin={origin} onSignedOut={onSignedOut} />}
      </div>
      {step === 'first' && (
        <ConfirmDialog
          title="Clear local data?"
          description={CLEAR_DESCRIPTION}
          confirmLabel="Clear local data"
          busy={clearing}
          error={clearError}
          onConfirm={() => void latch(advance)}
          onCancel={closeDialog}
        />
      )}
      {step === 'second' && (
        <ConfirmDialog
          title={risk === null ? 'Delete data that may not be uploaded?' : `Delete ${items(risk.total)} that ${risk.total === 1 ? 'is' : 'are'} not uploaded?`}
          description={SECOND_DESCRIPTION}
          details={
            risk === null ? (
              <Notice tone="watch">{COUNT_UNKNOWN}</Notice>
            ) : (
              <ul data-testid="at-risk" className="list-disc pl-5 text-base font-semibold text-ih-fg-1">
                {atRiskLines(risk).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )
          }
          confirmLabel="Delete everything"
          cancelLabel="Keep my data"
          destructive
          busy={clearing}
          error={clearError}
          onConfirm={() => void latch(clear)}
          onCancel={closeDialog}
        />
      )}
    </Screen>
  );
}
