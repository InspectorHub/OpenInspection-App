import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createExecFileHelperSpawner } from './heic-helper-process.ts';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

/** A child whose stdin fails the way a pipe does when the helper has already exited. */
function fakeChild() {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(() => { setImmediate(() => stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))); return true; }),
    end: vi.fn(),
  });
  return Object.assign(new EventEmitter(), { stdin, stdout: new EventEmitter(), exitCode: null, signalCode: null, kill: vi.fn() });
}

describe('createExecFileHelperSpawner', () => {
  it('uses execFile with a closed argument list, no shell, and bounded hidden output', async () => {
    const source = await readFile(new URL('./heic-helper-process.ts', import.meta.url), 'utf8');
    expect(source).toContain('execFile(exePath, [...args]');
    expect(source).toContain('shell: false');
    expect(source).toContain('windowsHide: true');
    expect(source).toContain('maxBuffer: MAX_MEDIA_BYTES + 1');
    expect(source).not.toMatch(/shell\s*:\s*true/);
    expect(source).not.toMatch(/\bexec\s*\(/);
  });

  it('survives a stdin pipe error after an early helper exit and still reports the exit code', async () => {
    const child = fakeChild();
    execFile.mockReturnValue(child);
    const process = createExecFileHelperSpawner().spawn('helper.exe', ['--decode']);
    const exits: Array<[number | null, string | null]> = [];
    process.onExit((code, signal) => exits.push([code, signal]));
    const uncaught = vi.fn();
    globalThis.process.on('uncaughtException', uncaught);
    try {
      process.stdin.write(new Uint8Array([1, 2, 3]));
      child.emit('close', 3, null);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally { globalThis.process.off('uncaughtException', uncaught); }
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(uncaught).not.toHaveBeenCalled();
    expect(exits).toEqual([[3, null]]);
  });

  it('keeps a listener on stdin so an unexpected stream error cannot reach the main process unhandled', () => {
    const child = fakeChild();
    execFile.mockReturnValue(child);
    createExecFileHelperSpawner().spawn('helper.exe', []);
    expect(child.stdin.listenerCount('error')).toBeGreaterThan(0);
  });
});
