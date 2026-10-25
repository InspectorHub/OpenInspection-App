import type { InspectionRefresh, WorkPackageRefresher } from '../offline/work-package';

/** Asks, waits for the other flows to finish, asks again: at most this many asks per inspection. */
const MAX_ATTEMPTS = 4;

/**
 * When the replayer has sent rows for an inspection, what the server holds has changed, but the cached copy the editor
 * reads still shows the old state (and the queued-write overlay is gone with the row). This refreshes exactly those
 * inspections, one after the other, through the refresher's single-inspection entry point, so its account, lock,
 * network, lease and blocked guards all apply. If another flow holds the lease it waits for that flow and asks once more.
 * It never throws and never changes what the replayer did.
 */
export function createRefreshAfterReplay(deps: {
  refresher: Pick<WorkPackageRefresher, 'refreshInspection'>;
  /** Settles when the flows that take the lease (the full refresh, the reconcile) are idle. */
  settle(): Promise<void>;
  isStopped(): boolean;
}): (inspectionIds: readonly string[]) => Promise<void> {
  return async (inspectionIds) => {
    for (const id of inspectionIds) {
      if (deps.isStopped()) return;
      try {
        let outcome: InspectionRefresh = await deps.refresher.refreshInspection(id);
        for (let attempt = 1; outcome.kind === 'busy' && attempt < MAX_ATTEMPTS && !deps.isStopped(); attempt += 1) {
          await deps.settle();
          if (!deps.isStopped()) outcome = await deps.refresher.refreshInspection(id);
        }
      } catch {
        // The cache stays as it was; the next full refresh catches up.
      }
    }
  };
}
