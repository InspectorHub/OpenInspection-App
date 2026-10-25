import type { DiscardMediaOutcome, DiscardOutboxOutcome, RemoveOutcome } from '../../offline/user-actions';
import type { DiscardResult } from '../../offline/replay';
import type { RefreshErrorCode, RefreshHalt, RefreshSummary } from '../../offline/work-package';
import type { OutboxErrorCode } from '../../platform/schema';

/**
 * Every sentence the work list can say about the offline machinery. All of it is ours and fixed: nothing the server
 * said, no error message, no id and no path is ever part of any of these. Words about an inspection that left the
 * list never say "deleted" alone, because the server cannot tell deleted from reassigned from never existed.
 */

export const REFRESH_ERROR_TEXT: Record<RefreshErrorCode, string> = {
  not_found: 'The server did not find this inspection during the last download.',
  not_visible: 'The server no longer shows this inspection to you.',
  refused: 'The server refused the last download.',
  invalid_response: 'The server sent an answer the app could not use.',
  too_large: 'The last download was too large to keep.',
  rate_limited: 'The server asked the app to slow down. It will try again.',
  server_error: 'The server had a problem during the last download.',
  network: 'The last download was interrupted. It will try again.',
  storage_failed: 'The last download could not be saved. Free up storage.',
};

export const OUTBOX_ERROR_TEXT: Record<OutboxErrorCode, string> = {
  corrupt_payload: 'The saved change is unreadable. Its data is kept so it can be copied.',
  unknown_op: 'This kind of change is not known to this version of the app.',
  unknown_registry_version: 'This change was saved by a different version of the app.',
  validation_failed: 'The server did not accept the values in this change.',
  holiday_blocked: 'The server does not allow this date. Change the date and try again.',
  inspection_cancelled: 'The inspection was cancelled, so this change cannot be applied.',
  quota_refused: 'The plan limit was reached, so the server refused this change.',
  conflict: 'The server holds a conflicting version of this inspection.',
  id_conflict: 'The server already uses this inspection id for something else.',
  key_reused: 'The server saw this change before with different contents.',
  rejected: 'The server refused this change.',
  unexpected_response: 'The server answered in a way the app did not expect.',
  network: 'The connection dropped while sending this change.',
  server_error: 'The server had a problem while receiving this change.',
  rate_limited: 'The server asked the app to slow down.',
  in_flight: 'The server is still handling an earlier attempt.',
  target_not_visible: 'The server no longer shows this inspection to you.',
  target_gone: 'This inspection is no longer on your list, so the change is not sent.',
};

export const OUTBOX_ERROR_UNKNOWN = 'This change could not be sent.';

const OP_LABELS: Record<string, string> = {
  'inspection.create': 'New inspection',
  'inspection.update': 'Inspection edit',
  'inspection.complete': 'Mark complete',
};

export function opLabel(op: string): string {
  return Object.hasOwn(OP_LABELS, op) ? (OP_LABELS[op] ?? 'Queued change') : 'Queued change';
}

export function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function bytesLabel(n: number): string {
  return n === 1 ? '1 byte' : `${String(n)} bytes`;
}

const REFRESH_HALT_TEXT: Record<RefreshHalt, string> = {
  offline: 'You are offline. Connect to the internet to download.',
  rate_limited: 'The server asked the app to slow down. Try again in a few minutes.',
  upgrade_required: 'Update the app to keep syncing.',
  auth: 'Sign in again to keep syncing.',
  locked: 'The app is locked. Verify online first.',
  list_failed: 'Could not get your list from the server. Try again.',
  request_cap: 'The download stopped early. Try again.',
  too_many_errors: 'The download stopped early. Try again.',
  storage_failed: 'The download could not be saved. Free up storage and try again.',
  lease_lost: 'The download did not finish. Try again.',
  no_account: 'The download did not finish. Try again.',
  stopped: 'The download did not finish. Try again.',
};

export const REFRESH_THREW_TEXT = 'The download did not finish. Try again.';

/** The network is up but the last contact with the server got no answer. Nothing is wrong with the sign-in. */
export const SERVER_UNREACHABLE_TEXT = "The server can't be reached right now. Your work is saved on this device and will sync when it is back.";

/** The server answered but sync cannot go on, or this device's storage failed. Not a sign-in problem, and not an unreachable server. */
export const SYNC_PAUSED_TEXT = 'Sync is paused. The app will try again shortly.';

/** One sentence group for what a download run did. */
export function refreshSummaryText(summary: RefreshSummary): string {
  if (summary.halted !== null) {
    const done = summary.refreshed > 0 ? ` Updated ${plural(summary.refreshed, 'inspection', 'inspections')} first.` : '';
    return `${REFRESH_HALT_TEXT[summary.halted]}${done}`;
  }
  if (summary.leaseBusy) return 'Another sync step is running. Try again in a moment.';
  const parts: string[] = [];
  if (summary.refreshed > 0) parts.push(`Updated ${plural(summary.refreshed, 'inspection', 'inspections')}.`);
  if (summary.failed > 0) parts.push(`${String(summary.failed)} could not be downloaded.`);
  if (summary.cacheFull || summary.skippedCacheFull > 0) {
    parts.push('Storage is almost full.');
    if (summary.skippedCacheFull > 0) parts.push(`${plural(summary.skippedCacheFull, 'inspection was', 'inspections were')} not downloaded.`);
  }
  return parts.length > 0 ? parts.join(' ') : 'Everything is already up to date.';
}

const FAILED_REMOVE = 'Could not remove everything. Nothing else was changed. Try again.';
const NOT_AVAILABLE = 'This action is not available right now. Check again, then try once more.';
const LOCKED = 'The app is locked. Verify online first.';
const BUSY = 'Another sync step is running. Try again in a moment.';
const SIGN_IN = 'Sign in again to continue.';

/** The message for a removal that did not happen. `purged` has none. */
export function removeFailureText(outcome: Exclude<RemoveOutcome, { kind: 'purged' }>): string {
  switch (outcome.kind) {
    case 'locked':
      return LOCKED;
    case 'busy':
      return BUSY;
    case 'lease_lost':
      return 'Another sync step took over. Nothing was lost. Try again in a moment.';
    case 'deferred':
      return 'Close the inspection first, then try again.';
    case 'unsent_now':
      return 'New unsent data appeared. Check the counts and try again.';
    case 'failed':
      if (outcome.code === 'foreign_outbox') return 'A queued change of another account is stored for this inspection. That account has to sign in to deal with it.';
      if (outcome.code === 'interrupted') return 'The removal was interrupted. Try again to finish it.';
      return FAILED_REMOVE;
    case 'refused':
      switch (outcome.reason) {
        case 'plan_not_issued':
        case 'not_authorized':
          return NOT_AVAILABLE;
        case 'not_quarantined':
          return 'This inspection is still on your list, so it cannot be removed.';
        case 'no_account':
          return SIGN_IN;
        case 'not_owner':
          return 'This inspection belongs to another account on this device.';
        case 'no_package':
          return 'This inspection is no longer on this device.';
        case 'changed':
          return 'This inspection changed since it was checked. Review it and try again.';
        case 'create_pending':
          return 'A new inspection made on this device has not been sent yet.';
        case 'unattributable':
          return 'A queued change is not linked to an inspection. Review the queued changes first.';
        case 'invalid_id':
        case 'unconfirmed':
        case 'quarantined':
        case 'tombstoned':
        case 'not_tombstoned':
          return 'This action could not be carried out.';
      }
  }
}

export { FAILED_REMOVE as REMOVE_THREW_TEXT };

export function discardMediaFailureText(outcome: Exclude<DiscardMediaOutcome, { kind: 'discarded' }>): string {
  switch (outcome.kind) {
    case 'locked':
      return LOCKED;
    case 'not_found':
      return 'This photo is already gone.';
    case 'refused':
      if (outcome.reason === 'purging') return 'This inspection is being removed from the device.';
      if (outcome.reason === 'no_account') return SIGN_IN;
      return 'This photo cannot be discarded from here.';
    case 'failed':
      return outcome.code === 'file_remove_failed' ? 'The photo file could not be removed. Try again.' : 'Could not discard the photo. Try again.';
  }
}

export function discardOutboxFailureText(outcome: Exclude<DiscardOutboxOutcome, { kind: 'discarded' }>): string {
  switch (outcome.kind) {
    case 'locked':
      return LOCKED;
    case 'not_found':
      return 'This change is already gone.';
    case 'refused':
      if (outcome.reason === 'not_unattributable') return 'This change is linked to an inspection, so it cannot be discarded from here.';
      if (outcome.reason === 'foreign') return 'This change belongs to another account on this device.';
      return SIGN_IN;
  }
}

export const DISCARD_CHANGE_GONE = 'Could not discard this change. It may already be gone.';

/** The message for a queued change that was not discarded. `discarded` has none. */
export function discardChangeFailureText(outcome: Exclude<DiscardResult, { kind: 'discarded' }>): string {
  switch (outcome.kind) {
    case 'locked':
      return LOCKED;
    case 'busy':
      return BUSY;
    case 'not_found':
      return DISCARD_CHANGE_GONE;
  }
}
export const DISCARD_THREW = 'Could not discard this change. Try again.';
export const PIN_REFUSED = 'This inspection cannot be pinned right now.';
export const LOAD_FAILED = 'Could not read the work list from this device.';
export const COUNTS_FAILED = 'Could not check what is on this device. Close this and try again.';

export const RETRY_THREW = 'Could not retry. Try again.';
export const CHECK_THREW = 'Could not start the check. Try again.';
export const CHECK_REQUESTED = 'Check requested.';
export const CHECK_IGNORED = 'Check could not run (offline or locked)';
export const DATE_UNAVAILABLE = 'Date unavailable';
export const ROW_UNAVAILABLE = 'This inspection could not be displayed';
export const REMOVE_GONE = 'This inspection is no longer on this device.';
export const REMOVE_NOT_ALLOWED = 'This inspection can no longer be removed from here. Check the list.';
export const REMOVE_RUNNING = 'This inspection is being removed. It will finish on its own.';

const OP_CONSEQUENCE: Record<string, string> = {
  'inspection.update': 'These edits to the inspection details will not be sent.',
  'inspection.complete': 'Marking the inspection complete will not be sent.',
  'inspection.create': 'This new inspection will not be sent to the server.',
};

/** What is lost when a queued change of this kind is discarded. Fixed text per kind; an unknown kind gets the general one. */
export function opConsequence(op: string): string {
  return Object.hasOwn(OP_CONSEQUENCE, op) ? (OP_CONSEQUENCE[op] ?? 'This queued change will not be sent.') : 'This queued change will not be sent.';
}
