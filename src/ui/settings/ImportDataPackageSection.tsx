/**
 * Electron-only Settings section for the tenant data-package import (A-7).
 * The web app never renders this. The main process opens the package, verifies
 * it locally, and drives the engine; this panel only collects a local file
 * path, a re-entered password, and shows progress/result from the import event
 * stream. No package bytes and no secrets pass through UI state.
 *
 * Revert is irreversible: before starting it the owner must confirm in a
 * destructive dialog that ALL imported rows will be deleted, including any
 * edited since the import.
 */
import { useEffect, useRef, useState } from 'react';
import { getDesktopBridge } from '../../desktop/bridge';
import type {
  DataPackageImportEvent, DataPackageImportResultView, DataPackageProgressView,
} from '../../../electron/shared/ipc-contract.ts';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button, INPUT_CLASSES } from '../kit';

export interface ImportDataPackageSectionProps {
  readonly origin: string;
  readonly getBearer: () => Promise<string | null>;
  readonly deviceLabel: string;
  readonly clientKind: string;
}

type Phase = 'idle' | 'prompting' | 'running' | 'done' | 'error';

/** Copy pinned by tests; keep reason strings short and free of markup. */
export const IMPORT_INTRO = 'Restore a data package from another workspace into this one. The file is read on this computer and verified before anything is sent.';
export const REVERT_TITLE = 'Undo this import permanently?';
export const REVERT_DESCRIPTION = 'This deletes every row and photo the import created, including anything you changed since the import. It cannot be undone.';
export const REVERT_CONFIRM = 'Delete imported data';

function countsOf(result: DataPackageImportResultView | null): string {
  if (!result) return '';
  const tables = Object.keys(result.counts).length;
  const applied = Object.values(result.applied).reduce((a, b) => a + b, 0);
  const rejected = result.rejected.length;
  return `${applied} rows across ${tables} table${tables === 1 ? '' : 's'}, ${result.mediaUploaded} photos; ${rejected} rejected.`;
}

export function ImportDataPackageSection(props: ImportDataPackageSectionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [filePath, setFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState<DataPackageProgressView | null>(null);
  const [result, setResult] = useState<DataPackageImportResultView | null>(null);
  const [error, setError] = useState('');
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getDesktopBridge().dataPackage.onImportEvent((event: DataPackageImportEvent) => {
        if (!alive.current) return;
        if (event.kind === 'progress') setProgress(event.progress);
        else if (event.kind === 'done') { setResult(event.result); setPhase('done'); }
        else if (event.kind === 'error') { setError(event.code); setPhase('error'); }
        else if (event.kind === 'reverted') {
          setRevertBusy(false); setRevertOpen(false); setResult(null);
          setFilePath(null); setPassword(''); setProgress(null); setPhase('idle');
        }
      });
    } catch {
      // Not inside the desktop client; section is inert.
    }
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);

  const chooseFile = async (): Promise<void> => {
    try {
      const picked = await getDesktopBridge().dialogs.pickPackage();
      if (picked) { setFilePath(picked); setError(''); }
    } catch {
      setError('could-not-pick-file');
    }
  };

  const submit = async (): Promise<void> => {
    if (!filePath) { setError('no-file'); setPhase('error'); return; }
    const bearer = await props.getBearer();
    if (!bearer) { setError('not-signed-in'); setPhase('error'); return; }
    setPhase('running');
    setProgress(null);
    try {
      await getDesktopBridge().dataPackage.startImport({
        serverUrl: props.origin, bearer, stepUpPassword: password,
        deviceLabel: props.deviceLabel, clientKind: props.clientKind, packagePath: filePath,
      });
      // Keep the password in memory (the input is already unmounted by the
      // phase change) so a subsequent revert can mint its own step-up token.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import-failed');
      setPhase('error');
    }
  };

  const confirmRevert = async (): Promise<void> => {
    const bearer = await props.getBearer();
    if (!bearer) { setRevertError('not-signed-in'); return; }
    setRevertBusy(true);
    setRevertError(null);
    try {
      await getDesktopBridge().dataPackage.revertImport({
        serverUrl: props.origin, bearer, stepUpPassword: password,
        deviceLabel: props.deviceLabel, clientKind: props.clientKind,
        packagePath: filePath ?? '',
      });
      // The 'reverted' event closes the dialog and resets the panel.
    } catch (err) {
      setRevertBusy(false);
      setRevertError(err instanceof Error ? err.message : 'revert-failed');
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-ih-card border border-ih-border p-4">
      <h2 className="font-ih-display text-lg">Restore a data package</h2>
      <p className="text-sm text-ih-fg-2">{IMPORT_INTRO}</p>

      {phase === 'idle' && (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => void chooseFile()}>
            {filePath ? 'Choose a different file' : 'Choose package file'}
          </Button>
          {filePath && <p className="break-all text-sm text-ih-fg-3">{filePath}</p>}
          <Button disabled={!filePath} onClick={() => setPhase('prompting')}>Start import</Button>
        </div>
      )}

      {phase === 'prompting' && (
        <div className="flex flex-col gap-2">
          <label htmlFor="import-step-up" className="text-sm text-ih-fg-2">Re-enter your password to confirm</label>
          <input
            id="import-step-up" type="password" autoComplete="current-password"
            className={INPUT_CLASSES} value={password}
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
          <p className="text-sm text-ih-fg-2">
            {progress?.paused ? 'Paused.' : progress
              ? `${progress.doneTables} of ${progress.totalTables} tables, ${progress.rows} rows`
              : 'Verifying the package…'}
          </p>
        </div>
      )}

      {phase === 'done' && result && (
        <div role="status" className="flex flex-col gap-2 text-sm text-ih-fg-2">
          <p>Import complete. {countsOf(result)}</p>
          {result.rejected.length > 0 && (
            <ul className="list-disc pl-5">
              {result.rejected.slice(0, 10).map((r, i) => (
                <li key={i}>{r.table}: {r.sourceId} — {r.code}</li>
              ))}
            </ul>
          )}
          {result.excluded.length > 0 && (
            <p>{result.excluded.length} item(s) were not imported. Review them before deleting the package.</p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setPhase('idle')}>Done</Button>
            <Button variant="danger" onClick={() => { setRevertError(null); setRevertOpen(true); }}>Undo import</Button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="text-sm text-ih-bad-fg">Import could not complete: {error || 'unknown error'}.</p>
          <Button onClick={() => setPhase('prompting')}>Try again</Button>
        </div>
      )}

      {revertOpen && (
        <ConfirmDialog
          title={REVERT_TITLE}
          description={REVERT_DESCRIPTION}
          confirmLabel={REVERT_CONFIRM}
          destructive
          busy={revertBusy}
          error={revertError}
          details={<p className="text-sm text-ih-fg-2">{countsOf(result)}</p>}
          onConfirm={() => void confirmRevert()}
          onCancel={() => { if (!revertBusy) setRevertOpen(false); }}
        />
      )}
    </section>
  );
}
