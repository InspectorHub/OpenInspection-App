import { readFileSync } from 'node:fs';
import { parseBuiltAt } from './src/platform/build-info.ts';

/** Replaces the two compile-time constants used by Android and Electron renderer builds. */
export function buildDefines(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  const builtAt = process.env.APP_BUILT_AT ?? new Date().toISOString();
  if (parseBuiltAt(builtAt) === null) throw new Error(`APP_BUILT_AT is not a UTC ISO instant: ${builtAt}`);
  return { __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILT_AT__: JSON.stringify(builtAt) };
}
