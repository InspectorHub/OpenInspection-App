/**
 * Electron-only Settings section for the tenant data-package export (A-3).
 * The web app never renders this. The main process owns the export; this panel
 * collects the step-up password, starts the run, and shows progress/result from
 * the `dataPackage` event stream. No bytes and no secrets pass through the UI
 * state: the bearer is fetched on demand and handed to the main process for the
 * one run, and the step-up password is never stored after submit.
 */
import { useEffect, useRef, useState } from 'react';
import { FORMAT_LOCALE } from '../../platform/format-locale';
import { getDesktopBridge } from '../../desktop/bridge';
import type { DataPackageExportEvent, DataPackageProgressView, DataPackageResultView } from '../../../electron/shared/ipc-contract.ts';
import { Button, INPUT_CLASSES } from '../kit';

export interface ExportDataPackageSectionProps {
  readonly origin: string;
  /** Live native owner bearer, fetched at submit time (never cached here). */
  readonly getBearer: () => Promise<string | null>;
  readonly deviceLabel: string;
  readonly clientKind: string;
}

type Phase = 'idle' | 'prompting' | 'running' | 'done' | 'error';

export function ExportDataPackageSection(props: ExportDataPackageSectionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState<DataPackageProgressView | null>(null);
  // Estimate arrives only on the first progress event; keep it in its own state
  // so subsequent progress updates do not wipe the preview from the screen.
  const [estimate, setEstimate] = useState<DataPackageProgressView['estimate']>(undefined);
  const [result, setResult] = useState<DataPackageResultView | null>(null);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getDesktopBridge().dataPackage.onEvent((event: DataPackageExportEvent) => {
        if (!alive.current) return;
        if (event.kind === 'progress') {
          setProgress(event.progress);
          if (event.progress.estimate) setEstimate(event.progress.estimate);
        }
        else if (event.kind === 'done') { setResult(event.result); setAcknowledged(false); setPhase('done'); }
        else { setError(event.code); setPhase('error'); }
      });
    } catch {
      // Not inside the desktop client (e.g. a Capacitor build); section is inert.
    }
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);

  const submit = async (): Promise<void> => {
    const secret = password;
    // Clear the secret from component state before any await — a rejected token
    // fetch must not leave the password sitting in the input.
    setPassword('');
    try {
      const bearer = await props.getBearer();
      if (!bearer || secret.length === 0) {
        if (alive.current) { setError('A password and an active sign-in are required.'); setPhase('error'); }
        return;
      }
      setProgress(null);
      setEstimate(undefined);
      setResult(null);
      setError('');
      setPhase('running');
      await getDesktopBridge().dataPackage.startExport({
        serverUrl: props.origin, bearer, stepUpPassword: secret,
        deviceLabel: props.deviceLabel, clientKind: props.clientKind,
      });
    } catch {
      // The main process also emits an error event; keep the panel in error.
      if (alive.current) setPhase('error');
    }
  };

  const cancel = async (): Promise<void> => {
    try { await getDesktopBridge().dataPackage.cancelExport(); } catch { /* already finished */ }
  };
  const pause = async (): Promise<void> => {
    try { await getDesktopBridge().dataPackage.pauseExport(); } catch { /* already finished */ }
  };
  const resume = async (): Promise<void> => {
    try { await getDesktopBridge().dataPackage.resumeExport(); } catch { /* already finished */ }
  };

  return (
    <section aria-labelledby="dp-export-heading" className="flex flex-col gap-3">
      <h2 id="dp-export-heading" className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Complete data package
      </h2>
      <p className="text-sm text-ih-fg-2">
        Export everything for this company — including photos, signed records and reports — to a folder you choose.
        The export runs on this computer; the file is plaintext and contains personal information, so store it securely.
      </p>

      {phase === 'idle' && <Button onClick={() => setPhase('prompting')}>Start export</Button>}

      {phase === 'prompting' && (
        <div className="flex flex-col gap-2">
          <label htmlFor="dp-step-up" className="text-sm text-ih-fg-2">Re-enter your password to confirm</label>
          <input
            id="dp-step-up"
            type="password"
            autoComplete="current-password"
            className={INPUT_CLASSES}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex gap-2">
            <Button onClick={() => void submit()}>Confirm</Button>
            <Button variant="secondary" onClick={() => { setPhase('idle'); setPassword(''); }}>Cancel</Button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div role="status" className="flex flex-col gap-2">
          {estimate && (
            <p className="text-sm text-ih-fg-2">
              Estimated: {estimate.rows.toLocaleString(FORMAT_LOCALE)} rows,
              {' '}{Math.round(estimate.bytes / 1024 / 1024).toLocaleString(FORMAT_LOCALE)} MB,
              {' '}about {estimate.days} day{estimate.days === 1 ? '' : 's'}.
            </p>
          )}
          <p className="text-sm text-ih-fg-2">
            {progress?.paused ? 'Paused.' : progress ? `${progress.stage}: ${progress.rows} rows, ${progress.media} media` : 'Preparing…'}
          </p>
          <div className="flex gap-2">
            {progress?.paused
              ? <Button onClick={() => void resume()}>Resume export</Button>
              : <Button variant="secondary" onClick={() => void pause()}>Pause export</Button>}
            <Button variant="secondary" onClick={() => void cancel()}>Cancel export</Button>
          </div>
        </div>
      )}

      {phase === 'done' && result && (
        <div role="status" className="flex flex-col gap-2 text-sm text-ih-fg-2">
          <p>Export complete.</p>
          <p className="break-all">Folder: {result.outputDir}</p>
          <p className="break-all">Manifest SHA-256: {result.manifestSha256}</p>
          <p>{result.rows} rows, {result.media} media, {result.excluded.length} excluded.</p>
          {result.excluded.length > 0 && (
            <div className="flex flex-col gap-1">
              <p>Review the items that could not be included:</p>
              <ul className="list-disc pl-5">
                {result.excluded.map((item, i) => (
                  <li key={i}>{item.table}: {item.reason}</li>
                ))}
              </ul>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I understand these items are not in the export.
              </label>
            </div>
          )}
          <Button disabled={result.excluded.length > 0 && !acknowledged} onClick={() => setPhase('idle')}>Done</Button>
        </div>
      )}

      {phase === 'error' && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-sm text-ih-bad-fg">Export could not complete: {error || 'unknown error'}.</p>
          <Button onClick={() => setPhase('prompting')}>Try again</Button>
        </div>
      )}
    </section>
  );
}
