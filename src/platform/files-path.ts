/** The plugin's error code for a missing file (Android and iOS share the `OS-PLUG-FILE-` family). */
const NOT_FOUND_CODE = 'OS-PLUG-FILE-0008';

/** True only for the plugin's own "does not exist" answer, by its code or by its fixed message text. */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === NOT_FOUND_CODE) return true;
  return typeof message === 'string' && /does not exist/i.test(message);
}

/**
 * Paths are relative to the app's no-backup directory. Absolute paths, drive or
 * scheme prefixes, backslashes and `.`/`..` segments are rejected so a caller
 * can never address anything outside it.
 */
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0) throw new Error('File path must not be empty');
  for (const segment of path.split('/')) {
    const bad =
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes(':') ||
      /[\u0000-\u001f]/.test(segment);
    if (bad) throw new Error(`Unsafe file path: ${JSON.stringify(path)}`);
  }
}
