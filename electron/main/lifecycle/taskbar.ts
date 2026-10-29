import type { UploaderHost } from '../net/uploader-host.ts';

interface UploadEvent {
  name: string;
  id: string;
  payload?: { percent?: number };
}

export function createTaskbarProgress(deps: {
  win: { setProgressBar(value: number, options?: { mode: 'normal' | 'error' | 'none' }): void; isDestroyed?(): boolean };
  uploader: Pick<UploaderHost, 'onEvent' | 'onActiveCountChange'>;
}): () => void {
  const progress = new Map<string, number>();
  let activeCount = 0;
  // A failed upload marks the current batch until all uploads drain; the next batch starts fresh.
  let failedBatch = false;
  let disposed = false;
  const render = (): void => {
    if (disposed) return;
    if (activeCount === 0) {
      progress.clear();
      if (failedBatch) deps.win.setProgressBar(0, { mode: 'error' });
      else deps.win.setProgressBar(-1, { mode: 'none' });
      return;
    }
    const currentMode = failedBatch ? 'error' : 'normal';
    if (progress.size === 0) {
      deps.win.setProgressBar(0, { mode: currentMode });
      return;
    }
    const average = [...progress.values()].reduce((sum, value) => sum + value, 0) / activeCount;
    deps.win.setProgressBar(Math.max(0, Math.min(1, average / 100)), { mode: currentMode });
  };
  const onEvent = (event: UploadEvent): void => {
    if (event.name === 'uploading' && typeof event.payload?.percent === 'number' && Number.isFinite(event.payload.percent)) {
      progress.set(event.id, Math.max(0, Math.min(100, event.payload.percent)));
      render();
    } else if (event.name === 'completed' || event.name === 'failed') {
      progress.delete(event.id);
      if (event.name === 'failed') failedBatch = true;
      render();
    }
  };
  const removeEvent = deps.uploader.onEvent(onEvent);
  const removeCount = deps.uploader.onActiveCountChange((count) => {
    const nextCount = Math.max(0, count);
    if (activeCount === 0 && nextCount > 0) failedBatch = false;
    activeCount = nextCount;
    if (activeCount === 0) progress.clear();
    render();
  });
  render();
  return () => {
    if (disposed) return;
    disposed = true;
    removeEvent();
    removeCount();
    progress.clear();
    if (!deps.win.isDestroyed?.()) deps.win.setProgressBar(-1, { mode: 'none' });
  };
}
