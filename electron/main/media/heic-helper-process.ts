import { execFile } from 'node:child_process';
import { MAX_MEDIA_BYTES } from '../../../src/media/media-types.ts';
import type { HelperProcess, HelperSpawner } from './heic-helper.ts';

/** The helper has no child processes of its own; killing this process ends the complete decode operation. */
export const createExecFileHelperSpawner = (): HelperSpawner => ({
  spawn(exePath, args): HelperProcess {
    const child = execFile(exePath, [...args], {
      shell: false,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: MAX_MEDIA_BYTES + 1,
    }, () => undefined);
    // A helper that exits early (a refused or malformed input) closes its stdin while the bytes are still being written.
    // The resulting EPIPE is a stream error that would be unhandled in the main process; the exit code already carries the outcome.
    child.stdin?.on('error', () => undefined);
    return {
      stdin: {
        write: (bytes) => { child.stdin?.write(bytes); },
        end: () => { child.stdin?.end(); },
      },
      onStdout(listener) {
        child.stdout?.on('data', (chunk: Buffer) => listener(chunk));
      },
      onExit(listener) {
        child.once('close', (code, signal) => listener(code, signal));
      },
      kill() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      },
    };
  },
});
