import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, IPC_ERROR_CODES, type ChannelName, type IpcErrorCode } from '../shared/ipc-contract.ts';

const EVENTS = [
  'startup', 'startup-failed', 'second-instance', 'window-ready', 'renderer-load-failed', 'quit-shutdown-failed',
  'db-exists-check-failed', 'db-key-read-failed', 'db-key-write-failed', 'db-corrupt', 'db-open-failed',
  'helper-hash-mismatch', 'helper-crash', 'system-tool-unresolved',
  'updater-listener-failed', 'updater-network', 'updater-verify', 'updater-other',
] as const;
/**
 * What may follow `internal` on a request channel: a SQLite result class from a closed list and nothing else. It exists so a
 * CI failure that surfaced only as `internal` can be explained (busy and locked point at a lock held by a killed process,
 * corrupt at the file). Messages, paths and other codes (an fs code such as EPERM sits next to a path) never get in.
 */
export const INTERNAL_DETAILS = ['sqlite-busy', 'sqlite-locked', 'sqlite-corrupt', 'sqlite-readonly', 'sqlite-ioerr', 'sqlite-full', 'sqlite-cantopen', 'sqlite-constraint', 'sqlite-other'] as const;
export type InternalDetail = typeof INTERNAL_DETAILS[number];
/** A request channel and the closed code it ended with (optionally the closed detail after `internal`). */
type ChannelEvent = `${ChannelName} ${IpcErrorCode}` | `${ChannelName} internal ${InternalDetail}`;
export type LogEvent = typeof EVENTS[number] | ChannelEvent;
const MAX_BYTES = 1024 * 1024;

const CHANNEL_NAMES: readonly string[] = Object.values(CHANNELS).flatMap((group) => Object.values(group));

function isLoggable(event: string): boolean {
  if ((EVENTS as readonly string[]).includes(event)) return true;
  const space = event.indexOf(' ');
  if (space <= 0 || !CHANNEL_NAMES.includes(event.slice(0, space))) return false;
  const rest = event.slice(space + 1);
  if ((IPC_ERROR_CODES as readonly string[]).includes(rest)) return true;
  return rest.startsWith('internal ') && (INTERNAL_DETAILS as readonly string[]).includes(rest.slice('internal '.length));
}

/** Deliberately accepts no free-form fields: URLs, argv, errors and customer data never enter the log. */
export function createLogger(userData: string): (event: LogEvent) => void {
  const directory = join(userData, 'logs');
  const file = join(directory, 'main.log');
  return (event) => {
    if (!isLoggable(event)) return;
    try {
      mkdirSync(directory, { recursive: true });
      const line = JSON.stringify({ time: new Date().toISOString(), event }) + '\n';
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > MAX_BYTES) {
        rmSync(file + '.2', { force: true });
        if (existsSync(file + '.1')) renameSync(file + '.1', file + '.2');
        renameSync(file, file + '.1');
      }
      appendFileSync(file, line, 'utf8');
    } catch {
      // Logging is best effort; disk errors must not expose exception contents through another output.
    }
  };
}
