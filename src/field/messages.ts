import type { CommandResult } from '@inspectorhub/field-ui';

/**
 * The sentences the editor shows. `CommandResult.error` is displayed verbatim to the inspector, so it is always one
 * of these readable sentences and never an internal code. Code that has to recognise a result uses the predicates
 * below, not the text of the sentence at a call site.
 */
export const MESSAGES = {
  needsConnection: 'This needs an internet connection. Connect and try again.',
  blocked: 'This inspection is being removed from this device and cannot be used right now.',
  unavailable: 'This inspection is not available on this device.',
  notDownloaded: 'This inspection has not finished downloading to this device. Connect to the internet and open it again.',
  notSaved: 'The change could not be stored on this device. Try again.',
  invalidValue: 'One of the values is not valid. Check it and try again.',
  upgradeRequired: 'This version of the app is too old to do that. Update the app and try again.',
  sessionExpired: 'Your session has expired. Sign in again to continue.',
  forbidden: 'Your account is not allowed to do that.',
  requestFailed: 'The server could not complete that. Try again.',
  outcomeUnknown: 'The app lost contact with the server before it confirmed this change. The change may or may not have been saved, so check before trying again.',
  publishOutcomeUnknown: 'The app lost contact with the server before it confirmed the publish. The report may already be published, and publishing again can create a second revision, so check the report before trying again.',
  deviceLocked: 'This device needs to be verified online before it can send changes.',
  pendingChanges: 'Earlier changes on this inspection are still being sent. Try again in a moment.',
  cacheUnreadable: 'The copy of this inspection on this device could not be read. Connect to the internet and download it again.',
  stillSaving: 'The server is still saving your earlier attempt. Check the inspection before trying again; the change may already be there.',
  publishFailed: 'Could not publish the report. Try again.',
  structureNotSaved: 'The structure change was not saved. Try again.',
  syncNotConverged: 'Structure saved, but live sync did not converge. Reload to continue editing.',
  noSourceTemplate: 'There is no source template to update.',
  sourceTemplateUnreadable: 'Could not load the source template to update it.',
  sourceTemplateUnnamed: 'The source template has no name.',
  missingItem: 'Missing item.',
  followupNeedsLiveEditing: 'Live editing is not enabled on this deployment, so the follow-up verdict cannot be saved.',
  followupAmbiguous: 'This item appears in more than one unit of this round; the verdict was not recorded.',
  followupNotSaved: 'The follow-up verdict was not saved.',
  instanceNotRecorded: 'Could not record that instance.',
  unreadableAnswer: 'The server sent an answer the app could not read.',
  photoTooLarge: 'This photo is larger than 10 MB and cannot be uploaded.',
  photoTypeUnsupported: 'Only JPEG, PNG and HEIC photos can be uploaded.',
  photoNotPrepared: 'The photo could not be prepared for upload. Try again.',
  photoUploadFailed: 'The photo could not be uploaded. Try again.',
  photoGone: 'The photo this change belongs to is no longer in the inspection.',
  unreachable: 'The app could not reach the server. Try again.',
  videoRemovalUnavailable: 'Removing a video is not available in the app yet.',
  videoTooLarge: 'This video is larger than 200 MB and cannot be uploaded.',
  videoTypeUnsupported: 'Only MP4 and QuickTime videos can be uploaded.',
  videoDiskFull: 'There is not enough free space on this device to keep the video.',
  posterNotSaved: 'The poster frame was not saved.',
  videoNotPrepared:'The video could not be prepared for upload. Try again.',
  prefsNotSaved: 'The preferences were not saved.',
  commentNotSaved: 'The comment was not saved.',
  aiUnavailable: 'AI writing assistance is unavailable right now.',
  linkBlocked:'Only secure links can be opened from the app.',
} as const;

export function needsConnectionResult<D = undefined>(data?: D): CommandResult<D> {
  return data === undefined ? { ok: false, error: MESSAGES.needsConnection } : { ok: false, error: MESSAGES.needsConnection, data };
}

export function blockedResult(): CommandResult {
  return { ok: false, error: MESSAGES.blocked };
}

/** Like `failure`, typed for any command's data: a refusal never carries any. */
export function failureOf<D>(error: string): CommandResult<D> {
  return { ok: false, error };
}

export function blockedOf<D>(): CommandResult<D> {
  return { ok: false, error: MESSAGES.blocked };
}

export function failure(error: string): CommandResult {
  return { ok: false, error };
}

/** True for a result that asks the person to connect. The one place that knows how such a result looks. */
export function isNeedsConnection(result: CommandResult<unknown>): boolean {
  return !result.ok && result.error === MESSAGES.needsConnection;
}
