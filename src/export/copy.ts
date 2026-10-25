import type { ExportDone, ExportFailure } from './exporter';

/** The words the person reads around an export. Fixed sentences: nothing from a row, a payload or the server is ever put in one. */

export const EXPORT_TITLE = 'Export unsent data?';
export const EXPORT_CONFIRM_LABEL = 'Export';

/** Said when the company's name is not stored on the device: the sentence keeps its shape and names nobody wrongly. */
export const FALLBACK_COMPANY = 'Your company';

/** The responsibility sentence shown before every export. The file is not encrypted, and who keeps it is stated. */
export function responsibilityText(company: string | null): string {
  return `This file contains customers' personal information and is not encrypted. ${company ?? FALLBACK_COMPANY} is responsible for storing and deleting the file.`;
}

export const INCLUDE_QUARANTINED_LABEL = 'Include inspections that were removed from my list (quarantined)';

export const CHECKING_TEXT = 'Checking which inspections are still on your list…';
export const WORKING_TEXT = 'Preparing the export…';

export const UNCONFIRMED_NOTICE = 'We could not confirm these inspections still exist, so the receiving office may refuse some of them.';

export const NOTHING_TO_EXPORT = 'There is nothing on this device to export.';

export const PREPARE_FAILED_TEXT = 'The app could not check what this device holds. You can still export, or try the check again.';
export const PREPARE_RETRY_LABEL = 'Check again';

export const FAILURE_TEXT: Record<ExportFailure | 'busy' | 'unexpected', string> = {
  not_signed_in: 'This device has no signed-in account to export for.',
  invalid_account: 'The account stored on this device cannot be written into an export file. Sign in again, then export.',
  build_failed: 'The export file could not be prepared. Nothing on this device was changed. Try again.',
  share_failed: 'The share sheet could not be opened. Nothing on this device was changed. Try again.',
  busy: 'An export is already running.',
  unexpected: 'The export did not finish. Nothing on this device was changed. Try again.',
};

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** What the export will hold, said before the person chooses. */
export function countsText(included: number, quarantined: number): string {
  const base = `${plural(included, 'inspection', 'inspections')} will be exported.`;
  return quarantined > 0 ? `${base} ${plural(quarantined, 'removed one is', 'removed ones are')} left out.` : base;
}

/** Said in the question and in the result: the importer may refuse inspections whose report ids this server never sent. */
export function reportIdNotice(count: number): string {
  return count === 1
    ? '1 inspection may be refused by the receiving office because this server did not provide its report id. It is still included.'
    : `${String(count)} inspections may be refused by the receiving office because this server did not provide their report ids. They are still included.`;
}

/** Inspections the person saw in the question that were purged, quarantined or emptied before the file was built. */
export function changedText(count: number): string {
  return `${plural(count, 'inspection', 'inspections')} changed while the export was being prepared and ${count === 1 ? 'was' : 'were'} left out.`;
}

export const KEPT_TEXT = 'The temporary file will be deleted within 10 minutes.';
export const DELETED_TEXT = 'The temporary file was deleted from this device.';

/** What an export that reached the share sheet contained, and what happens to the temporary file. */
export function summaryText(done: ExportDone): string {
  const parts = [plural(done.inspections, 'inspection', 'inspections'), plural(done.photos, 'photo', 'photos'), plural(done.writes, 'change waiting to upload', 'changes waiting to upload')];
  const file = done.kept ? KEPT_TEXT : DELETED_TEXT;
  return done.kind === 'cancelled' ? `Sharing was cancelled or did not finish. It held ${parts.join(', ')}. ${file}` : `Export handed to the share sheet: ${parts.join(', ')}. ${file}`;
}

/** Things the package could not carry or left out, in the order the person should care about them. */
export function leftOutNotes(done: ExportDone): string[] {
  const { omitted } = done;
  const notes: string[] = [];
  if (done.photosMissing > 0) notes.push(`${plural(done.photosMissing, 'photo', 'photos')} could not be read and ${done.photosMissing === 1 ? 'was' : 'were'} left out.`);
  if (omitted.creationRefused > 0) notes.push(`${plural(omitted.creationRefused, 'inspection', 'inspections')} could not be exported because their creation was refused; they stay on this device.`);
  if (omitted.failedWrites > 0) notes.push(`${plural(omitted.failedWrites, 'change', 'changes')} the server refused stay on this device.`);
  if (omitted.reportIdUnknown > 0) notes.push(reportIdNotice(omitted.reportIdUnknown));
  if (done.changedSincePrepare > 0) notes.push(changedText(done.changedSincePrepare));
  if (omitted.videos > 0) notes.push(`Recorded video clips cannot be exported. ${plural(omitted.videos, 'inspection has', 'inspections have')} clips that stay on this device.`);
  if (omitted.photoEdits > 0) notes.push(`Photo crops and annotations cannot be exported. ${plural(omitted.photoEdits, 'inspection has', 'inspections have')} some that stay on this device.`);
  if (omitted.skippedWrites > 0) notes.push(`${plural(omitted.skippedWrites, 'waiting change', 'waiting changes')} could not be written to the file and ${omitted.skippedWrites === 1 ? 'was' : 'were'} left out.`);
  if (omitted.alreadyOnServer > 0) notes.push(`${plural(omitted.alreadyOnServer, 'inspection was', 'inspections were')} already fully on the server and ${omitted.alreadyOnServer === 1 ? 'was' : 'were'} left out.`);
  return notes;
}

export const LEFTOVER_NOTICE = 'The temporary export file could not be deleted. The app will delete it the next time it starts.';
