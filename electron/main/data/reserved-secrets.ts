/**
 * Secret keys the main process owns. The renderer reaches the same store through the `secrets` channels, so these
 * names are refused there: a renderer fault must not be able to read, replace or delete the database key.
 */
export const DB_KEY_NAME = 'db-key';
export const RESERVED_SECRET_KEYS: readonly string[] = [DB_KEY_NAME];
