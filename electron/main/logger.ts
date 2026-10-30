import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, IPC_ERROR_CODES, type ChannelName, type IpcErrorCode } from '../shared/ipc-contract.ts';

const EVENTS = [
  'startup', 'startup-failed', 'second-instance', 'window-ready', 'renderer-load-failed', 'quit-shutdown-failed',
  'db-exists-check-failed', 'db-key-read-failed', 'db-key-write-failed', 'db-corrupt', 'db-open-failed',
  'helper-hash-mismatch', 'helper-crash',
  'updater-listener-failed', 'updater-network', 'updater-verify', 'updater-other',
] as const;
/** A request channel and the closed code it ended with: the only shape of event that is built from two parts. */
type ChannelEvent = `${ChannelName} ${IpcErrorCode}`;
export type LogEvent = typeof EVENTS[number] | ChannelEvent;
const MAX_BYTES = 1024 * 1024;

const CHANNEL_NAMES: readonly string[] = Object.values(CHANNELS).flatMap((group) => Object.values(group));

function isLoggable(event: string): boolean {
  if ((EVENTS as readonly string[]).includes(event)) return true;
  const space = event.indexOf(' ');
  return space > 0 && CHANNEL_NAMES.includes(event.slice(0, space)) && (IPC_ERROR_CODES as readonly string[]).includes(event.slice(space + 1));
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
