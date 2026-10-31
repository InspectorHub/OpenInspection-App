import type { UploadBatch } from './batch.ts';

/** Mirrors the upload batch onto the window's taskbar button: monotonic progress, cleared only when the batch is over. */
export function createTaskbarProgress(deps: {
  win: { setProgressBar(value: number, options?: { mode: 'normal' | 'error' | 'none' }): void; isDestroyed?(): boolean };
  batch: Pick<UploadBatch, 'onChange'>;
}): () => void {
  let disposed = false;
  const removeChange = deps.batch.onChange((state) => {
    if (disposed) return;
    if (state.kind === 'running') deps.win.setProgressBar(Math.max(0, Math.min(1, state.progress)), { mode: state.failed ? 'error' : 'normal' });
    else if (state.kind === 'error-idle') deps.win.setProgressBar(0, { mode: 'error' });
    else deps.win.setProgressBar(-1, { mode: 'none' });
  });
  return () => {
    if (disposed) return;
    disposed = true;
    removeChange();
    if (!deps.win.isDestroyed?.()) deps.win.setProgressBar(-1, { mode: 'none' });
  };
}
