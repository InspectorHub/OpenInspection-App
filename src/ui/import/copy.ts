import { PACKAGE_MAX_AGE_DAYS, PACKAGE_MAX_FUTURE_SKEW_DAYS, type HeldBack, type HeldBackReason } from '@inspectorhub/offline-package';
import type { StopProblem } from '../../offline/import-package';
import { stripBidi } from '../worklist/format';

/**
 * What to tell a person about an inspection an import left behind.
 *
 * The shared import reports a `reason` per inspection plus the status and code of the server answer behind it. The reason alone does
 * not write the sentence: a refusal of the whole package is an ended session, an expired package or one dated ahead of the server,
 * and each has a different next step. The figures in the expired and future sentences are the ones the server named
 * (`details.maxAgeDays`, `details.maxFutureSkewDays`); the shared package's own constants are used only when the server named none.
 */

export interface HeldBackExplanation {
  /** Rows with the same group share one explanation, shown once above them. */
  group: string;
  /** Short label for the pill on each row. */
  label: string;
  what: string;
  next: string;
}

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/** `404 NOT_FOUND`, `409`, or null when no answer was ever confirmed. */
export function answerText(h: Pick<HeldBack, 'status' | 'code'>): string | null {
  const text = [h.status, h.code === undefined ? undefined : stripBidi(h.code)].filter((part) => part !== undefined && part !== '').join(' ');
  return text === '' ? null : text;
}

const LABELS: Record<HeldBackReason, string> = {
  not_found: 'Not found',
  forbidden: 'Not allowed',
  different_report: 'Different report',
  deleted: 'Deleted',
  apply_failed: 'Change refused',
  refused: 'Refused',
  too_large_to_split: 'Too large',
  package_rejected: 'Package refused',
  gave_up: 'Not confirmed',
};

const WHAT: Record<Exclude<HeldBackReason, 'package_rejected' | 'gave_up'>, string> = {
  not_found: 'This inspection does not exist in this company.',
  forbidden: 'Your account is not allowed to change this inspection.',
  different_report: 'The report in the package is not the report this inspection has now.',
  deleted: 'This inspection was deleted after the package was exported.',
  apply_failed: "The server could not apply this inspection's data or one of its changes.",
  refused: 'The server refused this inspection for a reason this version does not recognize.',
  too_large_to_split: 'This inspection alone is larger than the server accepts in one request.',
};

const NEXT: Record<HeldBackReason, string> = {
  not_found: 'Check that it was not removed, then keep the saved part until you know what to do with it.',
  forbidden: 'Ask an owner or manager who can open it to import this part.',
  different_report: 'Save this part and have the person who exported it check which report is current before importing again.',
  deleted: 'There is nothing to import for it. Keep the saved part only if you still need its data.',
  apply_failed: 'Save this part and import it again later. If it keeps failing, give the saved part and the answer shown to whoever runs your server.',
  refused: 'Save this part, update the app, and import it again.',
  too_large_to_split: 'Save this part to keep it, and export the inspection again from the app with fewer photos.',
  package_rejected: 'Your file has not been changed. Export it again from the app, or save this part and try again.',
  gave_up: 'Nothing was lost. Import the same file again later: importing is safe to repeat, and what was already imported is skipped.',
};

function explainPackageRejected(h: HeldBack): HeldBackExplanation {
  const label = LABELS.package_rejected;
  if (h.code === 'PACKAGE_EXPIRED') {
    const days = positive(h.details?.maxAgeDays, PACKAGE_MAX_AGE_DAYS);
    return { group: 'package_rejected:expired', label, what: `This package is more than ${String(days)} days old and can no longer be imported.`, next: 'Your file has not been changed. Export the data again from the device that holds it.' };
  }
  if (h.code === 'PACKAGE_FROM_THE_FUTURE') {
    const days = positive(h.details?.maxFutureSkewDays, PACKAGE_MAX_FUTURE_SKEW_DAYS);
    return {
      group: 'package_rejected:future',
      label,
      what: days === 1 ? "This package is dated more than 1 day ahead of the server's clock, so it was refused." : `This package is dated more than ${String(days)} days ahead of the server's clock, so it was refused.`,
      next: 'Check the date and time on the device that exported it, then export again. Your file has not been changed.',
    };
  }
  if (h.status === 401 || h.status === 403) {
    return {
      group: 'package_rejected:session',
      label,
      what: 'Your sign-in may have expired or your account may not have permission to import.',
      next: 'Sign in again and import again; your file has not been changed. If it happens again, check that the package was exported from this company.',
    };
  }
  return { group: 'package_rejected', label, what: 'The server refused the package as a whole, so no inspection in it was imported.', next: NEXT.package_rejected };
}

export function explainHeldBack(h: HeldBack): HeldBackExplanation {
  if (h.reason === 'package_rejected') return explainPackageRejected(h);
  if (h.reason === 'gave_up') {
    // `local_error` is the detail the shared import sets when the failure was on this side, not the server's.
    const local = h.detail === 'local_error';
    return {
      group: local ? 'gave_up:local' : h.reason,
      label: LABELS.gave_up,
      what: local ? 'Something failed on this device before the server could confirm this part.' : 'The server did not confirm this part in time.',
      next: NEXT.gave_up,
    };
  }
  return { group: h.reason, label: LABELS[h.reason], what: WHAT[h.reason], next: NEXT[h.reason] };
}

/** Held-back rows in the order their group first appears, each group once. */
export function groupHeldBack(rows: readonly HeldBack[]): Array<{ explanation: HeldBackExplanation; rows: HeldBack[] }> {
  const groups = new Map<string, { explanation: HeldBackExplanation; rows: HeldBack[] }>();
  for (const row of rows) {
    const explanation = explainHeldBack(row);
    const existing = groups.get(explanation.group);
    if (existing) existing.rows.push(row);
    else groups.set(explanation.group, { explanation, rows: [row] });
  }
  return [...groups.values()];
}

/** Why an import stopped before it was done, and what to do. Fixed text: nothing the server said reaches the screen. */
export const STOP_TEXT: Record<StopProblem, { title: string; body: string }> = {
  auth: { title: 'Sign in again', body: 'Your sign-in is no longer valid, so the import stopped. Sign in again, then import the file again. Anything already imported is skipped.' },
  locked: { title: 'This device is locked', body: 'This device must be verified online before it can sync, so the import stopped. Verify online, then import the file again.' },
  upgrade: { title: 'Update the app', body: 'This version of the app is no longer supported by the server, so the import stopped. Update the app, then import the file again.' },
  server_too_old: { title: 'The server is too old', body: 'The server is older than this app expects, so the import cannot run. Ask whoever runs the server to update it.' },
};

export const IMPORT_TITLE = 'Import a package';
export const CHOOSE_HEADING = 'Choose a package';
export const CHOOSE_BUTTON = 'Choose a package file';
export const CHOOSE_HINT_PREFIX = 'A .zip file exported from the app, up to';
export const CHOOSE_EMPTY = 'When a device cannot sync, the app can export what it holds as a .zip file. Choose that file here to import it. Nothing is uploaded until you confirm.';
export const PRIVACY_NOTE = 'A package holds client personal information and is not encrypted. Keep it safe, and delete it once it has been imported.';
export const READING = 'Reading the package...';
export const PREVIEW_HEADING = 'Package contents';
export const PREVIEW_NOTE = 'Nothing has been uploaded yet. This summary was read on this device.';
export const MATCH_OK = 'This package was exported for this company.';
export const MATCH_BAD = 'This package belongs to a different company, so it cannot be imported here. Sign in to the company it was exported from, or ask for a new export.';
export const REVIEW_LABEL = 'Review and import';
export const OTHER_FILE_LABEL = 'Choose a different file';
export const CONFIRM_TITLE = 'Import this package?';
export const CONFIRM_LABEL = 'Import package';
export const CONFIRM_PRIVACY = "This file contains client personal information and is not encrypted. Keeping it safe, and deleting it afterwards, is your company's responsibility.";
export const RUN_FAILED = 'The import could not start. Nothing was sent. Check that the file is the package the app exported, then try again.';
export const PROGRESS_HEADING = 'Importing';
export const PROGRESS_NOTE = 'Parts are sent one at a time. Closing the app is safe: your file is not changed, and importing it again is safe because anything already imported is skipped.';
export const RESULT_HEADING = 'Import finished';
export const ALL_IMPORTED = 'Everything in this package was imported.';
export const ALL_SKIPPED = 'Everything in this package had already been imported, so nothing changed.';
export const NONE_IMPORTED = 'Nothing in this package could be imported. Your file has not been changed: read why below, then import it again.';
export const AGAIN_LABEL = 'Import this file again';
export const ANOTHER_LABEL = 'Import another package';
export const DONE_LABEL = 'Done';
export const HELD_HEADING = 'Left behind';
export const HELD_INTRO = 'These inspections were not imported. Nothing was lost: save a part to keep it, fix the cause, and import it again.';
export const SAVE_FAILED = 'The part could not be saved. Your file has not been changed; try again.';
export const SAVED = 'Saved. Choose where to keep it in the sheet that opened.';
export const ATTENTION_HEADING = 'Changes the server refused';
export const ATTENTION_INTRO = 'These queued changes were not applied. The results and photos of their inspections were still imported, and these changes will not be sent again.';

export const confirmBody = (c: { inspections: number; writes: number; photos: number }): string =>
  `Inspections: ${String(c.inspections)}, queued changes: ${String(c.writes)}, photos: ${String(c.photos)}. All of it will be added to this company. Importing the same package again is safe: anything already imported is skipped.`;
export const progressInspections = (done: number, total: number): string => `${String(done)} of ${String(total)} inspections processed`;
export const progressCounts = (imported: number, held: number): string => `${String(imported)} inspections imported so far, ${String(held)} left behind`;
export const saveGroupLabel = (count: number): string => (count === 1 ? 'Save this part' : `Save these ${String(count)} as one package`);
export const unsentText = (count: number): string => (count === 1 ? '1 inspection was not sent.' : `${String(count)} inspections were not sent.`);

/** A package over this size is warned about: at a field uplink the upload can take several minutes. */
export const SLOW_UPLOAD_BYTES = 8 * 1024 * 1024;
export const SLOW_UPLOAD_NOTE = 'This package is large, so the upload can be slow on a weak connection and may take several minutes. If it is interrupted, importing it again is safe: anything already imported is skipped.';
