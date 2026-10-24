/**
 * Every failure the photo store and the document step can raise. The message is fixed text chosen here:
 * nothing from a path, a database error, a server or the plugin is ever copied into an error.
 */
export const MEDIA_ERROR_CODES = [
  'INVALID_ID',
  'INVALID_RECORD',
  'UNSUPPORTED_TYPE',
  'EMPTY',
  'TOO_LARGE',
  'READ_FAILED',
  'WRITE_FAILED',
  'DB_FAILED',
  'CONFLICT',
  'DELETE_FAILED',
  'DOC_BUSY',
  'DOC_FAILED',
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

const MESSAGES: Record<MediaErrorCode, string> = {
  INVALID_ID: 'The photo or inspection id is not valid',
  INVALID_RECORD: 'The photo record is not valid',
  UNSUPPORTED_TYPE: 'This photo type cannot be stored',
  EMPTY: 'The photo file is empty',
  TOO_LARGE: 'The photo file is too large',
  READ_FAILED: 'The photo could not be read',
  WRITE_FAILED: 'The photo file could not be saved',
  DB_FAILED: 'The photo record could not be saved',
  CONFLICT: 'A different photo already uses this id',
  DELETE_FAILED: 'The photo file could not be removed',
  DOC_BUSY: 'The inspection is open and its document is not available',
  DOC_FAILED: 'The inspection document could not be updated',
};

export class MediaError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MediaError';
    this.code = code;
  }
}

export function isMediaError(value: unknown): value is MediaError {
  return value instanceof MediaError;
}

/** Ids that name a photo or an inspection: the same pattern the engine applies to a pending id. */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidMediaId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_ID_PATTERN.test(value);
}
