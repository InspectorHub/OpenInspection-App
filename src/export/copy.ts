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

export const FAILURE_TEXT: Record<ExportFailure | 'busy' | 'unexpected', string> = {
  not_signed_in: 'This device has no signed-in account to export for.',
  build_failed: 'The export file could not be prepared. Nothing on this device was changed. Try again.',
  share_failed: 'The share sheet could not be opened. Nothing on this device was changed. Try again.',
  busy: 'An export is already running.',
  unexpected: 'The export did not finish. Nothing on this device was changed. Try again.',
};

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** What an export that reached the share sheet contained. */
export function summaryText(done: ExportDone): string {
  const parts = [plural(done.inspections, 'inspection', 'inspections'), plural(done.photos, 'photo', 'photos'), plural(done.writes, 'change waiting to upload', 'changes waiting to upload')];
  return done.kind === 'cancelled' ? `Sharing was cancelled. The export file was deleted. It held ${parts.join(', ')}.` : `Export handed to the share sheet: ${parts.join(', ')}. The temporary file was deleted from this device.`;
}

/** Things the package could not carry, in the order the person should care about them. */
export function leftOutNotes(done: ExportDone): string[] {
  const notes: string[] = [];
  if (done.photosMissing > 0) notes.push(`${plural(done.photosMissing, 'photo', 'photos')} could not be read and ${done.photosMissing === 1 ? 'was' : 'were'} left out.`);
  if (done.omitted.videos > 0) notes.push(`Recorded video clips cannot be exported. ${plural(done.omitted.videos, 'inspection has', 'inspections have')} clips that stay on this device.`);
  if (done.omitted.photoEdits > 0) notes.push(`Photo crops and annotations cannot be exported. ${plural(done.omitted.photoEdits, 'inspection has', 'inspections have')} some that stay on this device.`);
  if (done.omitted.skippedWrites > 0) notes.push(`${plural(done.omitted.skippedWrites, 'waiting change', 'waiting changes')} could not be written to the file and ${done.omitted.skippedWrites === 1 ? 'was' : 'were'} left out.`);
  return notes;
}

export const LEFTOVER_NOTICE = 'The temporary export file could not be deleted. The app will delete it the next time it starts.';
