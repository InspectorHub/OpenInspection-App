import { IMPORT_LIMIT_CEILINGS } from '@inspectorhub/offline-package';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Api } from '../../field/api-client';
import { tenantMatches } from '../../offline/import-package';
import { ACCEPT_PACKAGE_FILES, formatSize } from '../../offline/package-source';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button, Notice, Screen } from '../kit';
import { useActionLatch } from '../latch';
import { useBackHandler } from '../use-back-handler';
import {
  CHOOSE_BUTTON,
  CHOOSE_EMPTY,
  CHOOSE_HEADING,
  CHOOSE_HINT_PREFIX,
  CONFIRM_LABEL,
  CONFIRM_PRIVACY,
  CONFIRM_TITLE,
  confirmBody,
  IMPORT_TITLE,
  PRIVACY_NOTE,
  READING,
  SAVE_FAILED,
  SAVED,
  SLOW_UPLOAD_BYTES,
  SLOW_UPLOAD_NOTE,
} from './copy';
import { ImportProgressPanel } from './ImportProgressPanel';
import { ImportResult } from './ImportResult';
import { PackagePreview } from './PackagePreview';
import { useImportPackage, type ImportPackageDeps } from './use-import-package';

export interface ImportPackageProps {
  /** The authenticated client of this session (Bearer token, lock and version gates). */
  api: Pick<Api, 'send'>;
  /** The company this device is signed in to: the only one a package may belong to. */
  tenantId: string;
  /** Where a left-behind part is written and shared. */
  share: ImportPackageDeps['share'];
  now(): number;
  /** Back to Settings. */
  onClose(): void;
  /** Sends the person to the sign-in screen. Offered as the main action when the sign-in is what ended an import. */
  onSignInAgain?: (() => void) | undefined;
  /** Replaces the waits, the clock and the frame wait of the import. Tests only. */
  importDeps?: ImportPackageDeps['importDeps'];
}

/**
 * Bringing in a package another device exported: choose the file, look at what it holds, confirm, watch it go, read the result.
 *
 * The import runs as a series of component-level requests (see `offline/import-package.ts`), so the same-frame guard is here: one
 * ref-based latch lets the confirm tap through once, and a second tap that lands before the screen has changed is dropped. The back
 * key is used up while the import runs, so a stray press cannot leave half-way through the series.
 */
export function ImportPackage({ api, tenantId, share, now, onClose, onSignInAgain, importDeps }: ImportPackageProps) {
  const { state, choose, reset, start, savePart } = useImportPackage({ api, tenantId, share, now, ...(importDeps === undefined ? {} : { importDeps }) });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const latch = useActionLatch();
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = state.kind === 'running';

  useBackHandler(() => {
    if (!running) onClose();
    return true;
  });

  // Each step starts at its title, so a screen reader reads where it is.
  useEffect(() => {
    heading.current?.focus();
  }, [state.kind]);

  function onPicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // The input is only on screen while choosing and is a fresh one after every choice, so it never holds on to a file.
    if (file !== undefined) void choose(file);
  }

  function confirm(): void {
    setConfirming(false);
    void latch(start);
  }

  function save(ids: readonly string[]): void {
    void latch(async () => {
      setSaving(true);
      setSaveNote(null);
      const result = await savePart(ids);
      setSaving(false);
      if (result === 'failed') setSaveNote({ tone: 'bad', text: SAVE_FAILED });
      else if (result === 'saved') setSaveNote({ tone: 'info', text: SAVED });
    });
  }

  return (
    <Screen wide>
      {!running && (
        <button
          type="button"
          aria-label="Back to settings"
          className="inline-flex min-h-11 items-center gap-1 self-start text-base font-semibold text-ih-primary-text focus-visible:outline-none focus-visible:shadow-ih-focus"
          onClick={onClose}
        >
          <span aria-hidden="true">&lsaquo;</span>
          <span>Settings</span>
        </button>
      )}
      <h1 ref={heading} tabIndex={-1} className="font-ih-display text-2xl font-bold tracking-tight text-ih-fg-1 focus-visible:outline-none">
        {IMPORT_TITLE}
      </h1>

      {state.kind === 'choose' && (
        <section aria-label={CHOOSE_HEADING} className="flex flex-col gap-4">
          <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{CHOOSE_HEADING}</h2>
          <p className="text-sm text-ih-fg-3">{`${CHOOSE_HINT_PREFIX} ${formatSize(IMPORT_LIMIT_CEILINGS.compressedBytes)}.`}</p>
          <input ref={input} type="file" accept={ACCEPT_PACKAGE_FILES} className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="import-file-input" onChange={onPicked} />
          <Button variant="primary" onClick={() => input.current?.click()}>
            {CHOOSE_BUTTON}
          </Button>
          {state.error !== null && <Notice tone="bad">{state.error}</Notice>}
          <Notice tone="info">{PRIVACY_NOTE}</Notice>
          {state.error === null && <p className="text-sm text-ih-fg-3">{CHOOSE_EMPTY}</p>}
        </section>
      )}

      {state.kind === 'reading' && (
        <p role="status" aria-busy="true" className="text-base text-ih-fg-2">
          {READING}
        </p>
      )}

      {state.kind === 'preview' && (
        <>
          <PackagePreview
            summary={state.summary}
            fileName={state.fileName}
            belongsHere={tenantMatches(state.summary, tenantId)}
            error={state.error}
            onChooseOther={reset}
            onReview={() => setConfirming(true)}
          />
          {confirming && (
            <ConfirmDialog
              title={CONFIRM_TITLE}
              description={confirmBody({ inspections: state.summary.counts.inspections, writes: state.summary.counts.writes, photos: state.summary.counts.photos })}
              confirmLabel={CONFIRM_LABEL}
              details={
                <>
                  <Notice tone="watch">{CONFIRM_PRIVACY}</Notice>
                  {state.summary.bytes > SLOW_UPLOAD_BYTES && <Notice tone="info">{SLOW_UPLOAD_NOTE}</Notice>}
                </>
              }
              busy={false}
              error={null}
              onConfirm={confirm}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      )}

      {state.kind === 'running' && <ImportProgressPanel progress={state.progress} />}

      {state.kind === 'done' && (
        <ImportResult
          outcome={state.outcome}
          labels={state.labels}
          onSignInAgain={onSignInAgain}
          saveNote={saveNote}
          saving={saving}
          onSave={save}
          onAgain={() => void latch(start)}
          onAnother={() => {
            setSaveNote(null);
            reset();
          }}
          onDone={onClose}
        />
      )}
    </Screen>
  );
}
