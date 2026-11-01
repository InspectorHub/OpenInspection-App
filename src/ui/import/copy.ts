import type { HeldBack } from '@inspectorhub/offline-package';
import { stripBidi } from '../worklist/format';

/**
 * The words of the import screens other than the result page (whose sentences are decided in `result-model.ts`).
 * Plain words, sentence case, numbers as digits.
 */

/** `404 NOT_FOUND`, `409`, or null when no answer ever came. For the result page's details only, never its main text. */
export function answerText(h: Pick<HeldBack, 'status' | 'code'>): string | null {
  const text = [h.status, h.code === undefined ? undefined : stripBidi(h.code)].filter((part) => part !== undefined && part !== '').join(' ');
  return text === '' ? null : text;
}

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
export const PROGRESS_NOTE = 'The file is sent one piece at a time. Closing the app is safe: your file is not changed, and importing it again is safe because anything already imported is skipped.';
export const SAVE_FAILED = 'The file could not be saved. Nothing was changed. Try again.';
export const SAVED = 'Saved. Choose where to keep it in the sheet that opened.';

export const confirmBody = (c: { inspections: number; writes: number; photos: number }): string =>
  `Inspections: ${String(c.inspections)}, queued changes: ${String(c.writes)}, photos: ${String(c.photos)}. All of it will be added to this company. Importing the same package again is safe: anything already imported is skipped.`;
export const progressInspections = (done: number, total: number): string => `${String(done)} of ${String(total)} inspections processed`;
export const progressCounts = (imported: number, notImported: number): string => `${String(imported)} imported so far, ${String(notImported)} not imported`;

/** A package over this size is warned about: at a field uplink the upload can take several minutes. */
export const SLOW_UPLOAD_BYTES = 8 * 1024 * 1024;
export const SLOW_UPLOAD_NOTE = 'This package is large, so the upload can be slow on a weak connection and may take several minutes. If it is interrupted, importing it again is safe: anything already imported is skipped.';
