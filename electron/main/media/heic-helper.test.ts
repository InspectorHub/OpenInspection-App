import { describe, expect, it, vi } from 'vitest';
import { MAX_MEDIA_BYTES } from '../../../src/media/media-types.ts';
import { createHeicHelperRunner, type HelperProcess, type HelperSpawner } from './heic-helper.ts';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

class FakeProcess implements HelperProcess {
  readonly writes: Uint8Array[] = [];
  ended = false;
  killed = false;
  private stdout: ((chunk: Uint8Array) => void) | undefined;
  private exit: ((code: number | null, signal: string | null) => void) | undefined;
  stdin = { write: (bytes: Uint8Array) => this.writes.push(bytes), end: () => { this.ended = true; } };
  onStdout(listener: (chunk: Uint8Array) => void): void { this.stdout = listener; }
  onExit(listener: (code: number | null, signal: string | null) => void): void { this.exit = listener; }
  emit(bytes: Uint8Array): void { this.stdout?.(bytes); }
  finish(code: number | null, signal: string | null = null): void { this.exit?.(code, signal); }
  kill(): void { this.killed = true; }
}

function harness(options: { path?: string | null; maxInputBytes?: number; timeoutMs?: number } = {}) {
  const process = new FakeProcess();
  const spawn = vi.fn((_path: string, _args: readonly string[]) => process);
  let timeout: (() => void) | undefined;
  const clearTimeout = vi.fn();
  const logs: string[] = [];
  const runner = createHeicHelperRunner({
    exePath: async () => {
      if (options.path === 'throw') throw new Error('verification details must not escape');
      return options.path === undefined ? 'helper.exe' : options.path;
    },
    spawner: { spawn } as HelperSpawner,
    timers: { setTimeout: (callback) => { timeout = callback; return 1; }, clearTimeout },
    limits: { maxPixels: 64_000_000, maxInputBytes: options.maxInputBytes ?? 8, timeoutMs: options.timeoutMs ?? 30 },
    log: (code) => logs.push(code),
  });
  return { runner, process, spawn, logs, clearTimeout, expire: () => timeout?.() };
}

async function started(run: Promise<unknown>): Promise<void> { await Promise.resolve(); await Promise.resolve(); void run; }

describe('createHeicHelperRunner', () => {
  it('rejects empty and oversized input without starting the helper', async () => {
    const h = harness();
    await expect(h.runner.run({ bytes: new Uint8Array(), maxLongEdge: 100 })).resolves.toEqual({ ok: false, code: 'CORRUPT' });
    await expect(h.runner.run({ bytes: new Uint8Array(9), maxLongEdge: 100 })).resolves.toEqual({ ok: false, code: 'UNSUPPORTED' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('starts with validated fixed switches and sends only bytes on stdin', async () => {
    const h = harness();
    const input = Uint8Array.from([1, 2, 3]);
    const pending = h.runner.run({ bytes: input, maxLongEdge: 2048 });
    await started(pending);
    expect(h.spawn).toHaveBeenCalledWith('helper.exe', ['--max-long-edge', '2048']);
    expect(h.process.writes).toEqual([input]);
    expect(h.process.ended).toBe(true);
    h.process.emit(jpeg);
    h.process.finish(0);
    await expect(pending).resolves.toEqual({ ok: true, jpeg });
  });

  it('accepts input exactly at the configured input ceiling', async () => {
    const h = harness();
    const pending = h.runner.run({ bytes: new Uint8Array(8), maxLongEdge: 1 });
    await started(pending);
    expect(h.spawn).toHaveBeenCalledOnce();
    h.process.emit(jpeg);
    h.process.finish(0);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('does not launch for non-integer dimensions or invalid keep-original ceilings', async () => {
    const h = harness();
    await expect(h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 1.5 })).resolves.toEqual({ ok: false, code: 'UNSUPPORTED' });
    await expect(h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: Infinity, keepOriginal: { maxBytes: 0 } })).resolves.toEqual({ ok: false, code: 'UNSUPPORTED' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('uses the keep-original switch and enforces its byte ceiling', async () => {
    const h = harness();
    const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: Infinity, keepOriginal: { maxBytes: 1024 } });
    await started(pending);
    expect(h.spawn).toHaveBeenCalledWith('helper.exe', ['--keep-original-max-bytes', '1024']);
    h.process.emit(jpeg);
    h.process.finish(0);
    await expect(pending).resolves.toEqual({ ok: true, jpeg });

    const tooBig = harness();
    const rejected = tooBig.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: Infinity, keepOriginal: { maxBytes: 2 } });
    await started(rejected);
    tooBig.process.emit(jpeg);
    tooBig.process.finish(0);
    await expect(rejected).resolves.toEqual({ ok: false, code: 'TOO_LARGE_BYTES' });
  });

  it('rejects an output without a JPEG signature', async () => {
    const h = harness();
    const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 32 });
    await started(pending);
    h.process.emit(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    h.process.finish(0);
    await expect(pending).resolves.toEqual({ ok: false, code: 'CORRUPT' });
  });

  it('maps helper exit codes, and treats unknown exits, signals and empty output as corruption', async () => {
    for (const [code, expected] of [[2, 'CODEC_MISSING'], [3, 'UNSUPPORTED'], [4, 'TOO_LARGE_PIXELS'], [5, 'CORRUPT'], [6, 'TOO_LARGE_BYTES']] as const) {
      const h = harness();
      const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 32 });
      await started(pending);
      h.process.finish(code);
      await expect(pending).resolves.toEqual({ ok: false, code: expected });
    }
    for (const outcome of [{ code: 99, signal: null }, { code: 0, signal: 'SIGTERM' }, { code: 0, signal: null }]) {
      const h = harness();
      const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 32 });
      await started(pending);
      if (outcome.code === 0 && outcome.signal === null) h.process.emit(new Uint8Array());
      h.process.finish(outcome.code, outcome.signal);
      await expect(pending).resolves.toEqual({ ok: false, code: 'CORRUPT' });
      expect(h.logs).toContain('helper-crash');
    }
  });

  it('returns helper-missing without launching when path resolution fails', async () => {
    for (const path of [null, 'throw'] as const) {
      const h = harness({ path });
      await expect(h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 10 })).resolves.toEqual({ ok: false, code: 'HELPER_MISSING' });
      expect(h.spawn).not.toHaveBeenCalled();
    }
  });

  it('kills a timed out helper and lets the following request spawn again', async () => {
    const h = harness();
    const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 10 });
    await started(pending);
    h.expire();
    await expect(pending).resolves.toEqual({ ok: false, code: 'TIMEOUT' });
    expect(h.process.killed).toBe(true);
    expect(h.clearTimeout).toHaveBeenCalled();
  });

  it('does not overlap concurrent decodes', async () => {
    const procA = new FakeProcess();
    const procB = new FakeProcess();
    let next = 0;
    const spawner = { spawn: vi.fn(() => next++ === 0 ? procA : procB) };
    const runner = createHeicHelperRunner({ exePath: async () => 'helper.exe', spawner, timers: { setTimeout: () => 1, clearTimeout: () => undefined }, log: () => undefined });
    const first = runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 1 });
    await started(first);
    const second = runner.run({ bytes: Uint8Array.of(2), maxLongEdge: 2 });
    procA.emit(jpeg); procA.finish(0);
    await expect(first).resolves.toMatchObject({ ok: true });
    await started(second);
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
    procB.emit(jpeg); procB.finish(0);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('does not let a helper crash poison the next request', async () => {
    const crashed = new FakeProcess();
    const recovered = new FakeProcess();
    let next = 0;
    const spawner = { spawn: vi.fn(() => next++ === 0 ? crashed : recovered) };
    const runner = createHeicHelperRunner({ exePath: async () => 'helper.exe', spawner, timers: { setTimeout: () => 1, clearTimeout: () => undefined }, log: () => undefined });
    const first = runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 1 });
    await started(first);
    crashed.finish(99);
    await expect(first).resolves.toEqual({ ok: false, code: 'CORRUPT' });

    const second = runner.run({ bytes: Uint8Array.of(2), maxLongEdge: 2 });
    await started(second);
    expect(spawner.spawn).toHaveBeenCalledTimes(2);
    recovered.emit(jpeg);
    recovered.finish(0);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('refuses output above the media ceiling', async () => {
    const h = harness({ maxInputBytes: 1 });
    const pending = h.runner.run({ bytes: Uint8Array.of(1), maxLongEdge: 10 });
    await started(pending);
    const oversized = new Uint8Array(MAX_MEDIA_BYTES + 1).fill(0x11);
    oversized.set(jpeg.subarray(0, 3));
    h.process.emit(oversized);
    h.process.finish(0);
    await expect(pending).resolves.toEqual({ ok: false, code: 'TOO_LARGE_BYTES' });
    expect(h.process.killed).toBe(true);
  });
});
