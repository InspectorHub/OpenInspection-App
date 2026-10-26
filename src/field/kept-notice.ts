import type { TimerPort } from '../collab/timers';
import { photosKeptMessage } from './messages';

export type KeptKind = 'item' | 'defect';

/** Photos kept in one window are one notice. Long enough for a batch to fail together, short enough to feel immediate. */
export const KEPT_WINDOW_MS = 400;

export interface KeptNoticeDeps {
  timers: TimerPort;
  /** Shows one sentence. It never throws into the caller. */
  say(message: string): void;
}

/**
 * The notice for photos that failed to upload but were kept on the device. The first kept photo opens a window; every
 * one that follows inside it is only counted, and when the window closes ONE sentence is shown with the count. Item and
 * defect photos are counted apart, because their sentences differ. The sentence promises no automatic upload: a kept
 * photo that the server refuses for good is not retried, and the notice must hold for it too.
 */
export function createKeptNotice(deps: KeptNoticeDeps): (inspectionId: string, kind: KeptKind) => void {
  const counts: Record<KeptKind, number> = { item: 0, defect: 0 };
  const open: Record<KeptKind, boolean> = { item: false, defect: false };
  return (_inspectionId, kind) => {
    counts[kind] += 1;
    if (open[kind]) return;
    open[kind] = true;
    deps.timers.setTimeout(() => {
      const count = counts[kind];
      counts[kind] = 0;
      open[kind] = false;
      deps.say(photosKeptMessage(kind, count));
    }, KEPT_WINDOW_MS);
  };
}
