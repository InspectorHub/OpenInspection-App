import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EVENTS = ['startup', 'startup-failed', 'second-instance', 'renderer-load-failed'] as const;
export type LogEvent = typeof EVENTS[number];
const MAX_BYTES = 1024 * 1024;

/** Deliberately accepts no free-form fields: URLs, argv, errors and customer data never enter the log. */
export function createLogger(userData: string): (event: LogEvent) => void {
  const directory = join(userData, 'logs');
  const file = join(directory, 'main.log');
  return (event) => {
    if (!EVENTS.includes(event)) return;
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
