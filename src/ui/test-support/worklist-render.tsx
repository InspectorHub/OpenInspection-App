import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { OfflineStack, StackStatus } from '../../app/offline-stack';
import { createStore, type WritableStore } from '../../app/stack-store';
import type { ReconcileOutcome } from '../../offline/reconciler';
import type { RefreshSummary } from '../../offline/work-package';
import { WorkList, type WorkListProps } from '../WorkList';
import { NOW } from './worklist-world';

export function reconcileOutcome(patch: Partial<ReconcileOutcome> = {}): ReconcileOutcome {
  return {
    status: 'done',
    reason: null,
    at: NOW,
    massSuspicious: false,
    allMissing: false,
    candidateCount: 3,
    unavailableRole: false,
    refusedNullInspectionId: false,
    counts: null,
    resumed: 0,
    resumeFailed: false,
    ...patch,
  };
}

/** The same stack with the reconciler's latest outcome replaced. `trigger` is a spy. */
export function withOutcome(stack: OfflineStack, patch: Partial<ReconcileOutcome>): OfflineStack & { trigger: ReturnType<typeof vi.fn> } {
  const trigger = vi.fn();
  const outcome = reconcileOutcome(patch);
  return Object.assign({ ...stack, reconciler: { trigger, onNeedsReconcile: () => undefined, last: outcome } }, { trigger });
}

export function refreshSummary(patch: Partial<RefreshSummary> = {}): RefreshSummary {
  return { refreshed: 0, skipped: 0, failed: 0, invalidIds: 0, requests: 0, globalRefreshed: false, halted: null, leaseBusy: false, listTruncated: 0, skippedCacheFull: 0, cacheFull: false, ...patch };
}

export function renderList(stack: OfflineStack, props: Partial<WorkListProps> = {}) {
  return render(<WorkList stack={stack} now={() => NOW} locale="en-US" pollMs={0} {...props} />);
}

/** The same stack with a status store the test can write to. */
export function withStatus(stack: OfflineStack, initial: Partial<StackStatus> = {}): { stack: OfflineStack; status: WritableStore<StackStatus> } {
  const status = createStore<StackStatus>({ auth: false, upgrade: false, editsNotSaved: false, collabIssue: false, reconcile: 'never', ...initial });
  return { stack: { ...stack, status }, status };
}
