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
