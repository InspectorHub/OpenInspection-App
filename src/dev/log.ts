import type { CheckResult } from './checks/types';

export const LOG_PREFIX = '[diag]';
/** Lines kept on `globalThis.__diagLog`, which a debugger can read with a plain evaluate. */
const MAX_KEPT_LINES = 500;

export interface DiagSink {
  info(message: string): void;
}

/** The one line a result becomes in the console: `[diag] <id> <ok> <detail>`. Fixed words and numbers only. */
export function formatLine(result: CheckResult): string {
  return `${LOG_PREFIX} ${result.id} ${String(result.ok)} ${result.detail}`;
}

const lastLine = new Map<string, string>();

/**
 * Writes the result to the console and keeps it on `globalThis.__diagLog`. A line identical to the previous
 * one for the same check is skipped, so the one second counter of the kill test logs only when it moves.
 */
export function logResult(result: CheckResult, sink: DiagSink = console): void {
  const line = formatLine(result);
  if (lastLine.get(result.id) === line) return;
  lastLine.set(result.id, line);
  sink.info(line);
  const holder = globalThis as { __diagLog?: string[] };
  const kept = (holder.__diagLog ??= []);
  kept.push(line);
  if (kept.length > MAX_KEPT_LINES) kept.splice(0, kept.length - MAX_KEPT_LINES);
}

/** Forgets the last-line memory; tests use it between cases. */
export function resetLog(): void {
  lastLine.clear();
  (globalThis as { __diagLog?: string[] }).__diagLog = [];
}
