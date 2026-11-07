import { useEffect, useId, useState } from 'react';
import type { AppServices } from '../app/compose';
import type { IdentityMismatch } from '../auth/errors';
import { countAtRisk, type AtRisk } from '../offline/at-risk';
import { atRiskLines, ClearLocalDataControl, COUNT_UNKNOWN } from './ClearLocalDataControl';
import { Button, Notice, Panel, PanelHeading } from './kit';

export interface IdentityMismatchPanelProps {
  services: Pick<AppServices, 'db' | 'files' | 'tokens' | 'clock'>;
  /** The server the person just signed in to. */
  origin: string;
  mismatch: IdentityMismatch;
  /** Leave the data alone and go back to sign-in. */
  onKeep(): void;
  /** The local data was removed (the person confirmed in the usual questions). */
  onCleared(): void;
  onWiping?(wiping: boolean): void;
}

/** "an owner", "an admin", "a manager": the role named with the right article. */
function withArticle(role: string): string {
  return `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`;
}

/** The server the stored identity last signed in to, or null when this device's data was saved before the app recorded it. */
async function loadStoredOrigin(db: AppServices['db']): Promise<string | null> {
  const rows = await db.query<{ value: unknown }>("SELECT value FROM device_state WHERE key = 'identity_origin'");
  const value = rows[0]?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface Facts {
  origin: string | null;
  risk: AtRisk | null;
}

/**
 * What a sign-in over another account's data says. The sign-in was refused before anything was stored, so this explains who is who,
 * what is on the device, and the two ways forward: keep the data and sign in as the original account, or remove it (through the
 * same questions as Settings, which count what has not been uploaded) and use this account. The facts are read-only.
 */
export function IdentityMismatchPanel({ services, origin, mismatch, onKeep, onCleared, onWiping }: IdentityMismatchPanelProps) {
  const titleId = useId();
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const [storedOrigin, risk] = await Promise.all([
        loadStoredOrigin(services.db).catch(() => null),
        countAtRisk(services.db).catch(() => null),
      ]);
      if (current) setFacts({ origin: storedOrigin, risk });
    })();
    return () => {
      current = false;
    };
  }, [services.db]);

  const lines = facts?.risk ? atRiskLines(facts.risk) : [];
  const who = mismatch.sameCompany
    ? `You signed in as a different person in the same company (as ${withArticle(mismatch.newRole)}). The data on this device belongs to ${withArticle(mismatch.storedRole)}.`
    : `You signed in to a different company (as ${withArticle(mismatch.newRole)}). The data on this device belongs to ${withArticle(mismatch.storedRole)} of another company.`;

  return (
    <Panel tone="watch" role="alert" titleId={titleId}>
      <PanelHeading id={titleId}>This device holds data for a different account.</PanelHeading>
      <p className="text-sm leading-relaxed">{who}</p>
      <dl className="flex flex-col gap-1 text-sm">
        <div>
          <dt className="font-semibold">You just signed in to</dt>
          <dd className="break-all font-ih-mono">{origin}</dd>
        </div>
        <div>
          <dt className="font-semibold">The data on this device came from</dt>
          <dd className="break-all font-ih-mono">{facts === null ? '…' : (facts.origin ?? 'a server this version of the app did not record')}</dd>
        </div>
      </dl>
      {facts?.origin != null && facts.origin !== origin && <p className="text-sm leading-relaxed">These are different servers.</p>}
      {facts !== null && facts.risk === null && <Notice tone="info">{COUNT_UNKNOWN}</Notice>}
      {facts?.risk && lines.length === 0 && <p className="text-sm leading-relaxed">Everything on this device has been uploaded.</p>}
      {lines.length > 0 && (
        <div className="text-sm leading-relaxed">
          <p className="font-semibold">Not yet on the server:</p>
          <ul data-testid="at-risk" className="list-disc pl-5">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-sm leading-relaxed">Nothing was changed or deleted. To keep this data, sign in with the account it belongs to.</p>
      <div className="flex flex-col gap-3">
        <Button onClick={onKeep}>Keep this device&apos;s data</Button>
        <ClearLocalDataControl
          services={services}
          origin={origin}
          onCleared={onCleared}
          {...(onWiping ? { onWiping } : {})}
          label="Remove this device's data and use this account"
        />
      </div>
    </Panel>
  );
}
