import type { TimerPort } from '../collab/timers';
import type { InspectionRefresh, WorkPackageRefresher } from '../offline/work-package';

/** The default bound on how long a command waits for the cache to catch up with its write. */
export const AFTER_WRITE_TIMEOUT_MS = 8000;
/** Asks, waits for the other flows to finish, asks again: at most this many asks. */
const MAX_ASKS = 3;

export interface AfterWriteDeps {
  refresher: Pick<WorkPackageRefresher, 'refreshInspection'>;
  /** Settles when the flows that take the lease (the full refresh, the reconcile) are idle. */
  settle(): Promise<void>;
  timers: TimerPort;
  timeoutMs?: number;
}

/**
 * After an online write succeeded, the cached copy the editor reads still shows the old state. This re-downloads that
 * inspection's reads through the refresher's single-inspection entry point (its account, lock, network, lease and
 * blocked guards all apply) and answers whether the cache now holds the server's state.
 *
 * It never rejects and never fails the write: a refresh that cannot be done, throws, or takes longer than the bound
 * answers `false`, and the caller reports a stale cache. The refresh that outlives the bound is left to finish by itself.
 */
export function createAfterWrite(deps: AfterWriteDeps): (inspectionId: string) => Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? AFTER_WRITE_TIMEOUT_MS;

  async function refresh(inspectionId: string): Promise<boolean> {
    let outcome: InspectionRefresh = await deps.refresher.refreshInspection(inspectionId);
    for (let asks = 1; outcome.kind === 'busy' && asks < MAX_ASKS; asks += 1) {
      await deps.settle();
      outcome = await deps.refresher.refreshInspection(inspectionId);
    }
    return outcome.kind === 'refreshed';
  }

  return (inspectionId) =>
    new Promise<boolean>((resolve) => {
      const timer = deps.timers.setTimeout(() => resolve(false), timeoutMs);
      refresh(inspectionId).then(
        (done) => {
          deps.timers.clearTimeout(timer);
          resolve(done);
        },
        () => {
          deps.timers.clearTimeout(timer);
          resolve(false);
        },
      );
    });
}
