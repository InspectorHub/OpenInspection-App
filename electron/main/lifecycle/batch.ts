import type { UploaderHost } from '../net/uploader-host.ts';

interface UploadEvent {
  name: string;
  id: string;
  payload?: { percent?: number };
}

export type BatchState =
  | { kind: 'running'; progress: number; failed: boolean }
  | { kind: 'error-idle' }
  | { kind: 'none' };

export interface IdleReport { completed: number; failures: number }

export interface UploadBatch {
  onChange(listener: (state: BatchState) => void): () => void;
  onIdle(listener: (report: IdleReport) => void): () => void;
  dispose(): void;
}

/**
 * The main process only sees uploads the renderer has already started, and the renderer starts them in waves, so the active
 * count touches 0 between waves. A batch therefore ends only after the count has stayed at 0 for a grace window; until then the
 * taskbar keeps its high-water mark and nothing is announced.
 */
export const BATCH_IDLE_GRACE_MS = 4000;

export function createUploadBatch(deps: {
  uploader: Pick<UploaderHost, 'onEvent' | 'onActiveCountChange'>;
  graceMs?: number;
  timers?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
}): UploadBatch {
  const timers = deps.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const graceMs = deps.graceMs ?? BATCH_IDLE_GRACE_MS;
  const changeListeners = new Set<(state: BatchState) => void>();
  const idleListeners = new Set<(report: IdleReport) => void>();
  const seen = new Set<string>();
  const fractions = new Map<string, number>();
  let finished = 0;
  let completed = 0;
  let failures = 0;
  let activeCount = 0;
  let highWater = 0;
  let timer: unknown = null;
  let disposed = false;
  let errorShown = false;
  // Started: a running state was shown for this batch. Lag: terminal events not yet followed by their count decrement.
  let started = false;
  let lag = 0;
  const emit = (state: BatchState): void => { for (const listener of changeListeners) { try { listener(state); } catch { /* listener isolation */ } } };
  const clearTimer = (): void => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };
  const reset = (): void => { started = false; lag = 0; seen.clear(); fractions.clear(); finished = 0; completed = 0; failures = 0; highWater = 0; };
  const render = (): void => {
    if (disposed) return;
    const total = Math.max(seen.size, finished + Math.max(0, activeCount - lag));
    let sum = finished;
    for (const fraction of fractions.values()) sum += fraction;
    if (total > 0) highWater = Math.max(highWater, Math.min(1, sum / total));
    started = true;
    emit({ kind: 'running', progress: highWater, failed: failures > 0 });
  };
  const endBatch = (): void => {
    timer = null;
    if (disposed) return;
    const report = { completed, failures };
    const hadFailures = failures > 0;
    reset();
    errorShown = hadFailures;
    emit(hadFailures ? { kind: 'error-idle' } : { kind: 'none' });
    if (report.completed + report.failures > 0) for (const listener of idleListeners) { try { listener(report); } catch { /* listener isolation */ } }
  };
  const removeEvent = deps.uploader.onEvent((event: UploadEvent) => {
    if (disposed) return;
    seen.add(event.id);
    if (event.name === 'uploading' && typeof event.payload?.percent === 'number' && Number.isFinite(event.payload.percent)) {
      fractions.set(event.id, Math.max(0, Math.min(100, event.payload.percent)) / 100);
    } else if (event.name === 'completed' || event.name === 'failed') {
      fractions.delete(event.id);
      finished += 1;
      lag += 1;
      if (event.name === 'completed') completed += 1; else failures += 1;
    } else return;
    render();
  });
  const removeCount = deps.uploader.onActiveCountChange((count) => {
    if (disposed) return;
    activeCount = Math.max(0, count);
    lag = 0;
    if (activeCount > 0) {
      clearTimer();
      errorShown = false;
      render();
    } else if (timer === null && started && !errorShown) {
      timer = timers.setTimeout(endBatch, graceMs);
    }
  });
  return {
    onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    onIdle(listener) { idleListeners.add(listener); return () => { idleListeners.delete(listener); }; },
    dispose() { if (disposed) return; disposed = true; clearTimer(); removeEvent(); removeCount(); changeListeners.clear(); idleListeners.clear(); },
  };
}
