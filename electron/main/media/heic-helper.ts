import { MAX_MEDIA_BYTES, MAX_DECODE_INPUT_BYTES, MAX_DECODE_PIXELS, DECODE_TIMEOUT_MS } from '../../../src/media/media-types.ts';
import type { TimerPort } from '../../../src/collab/timers.ts';

export type HeicFailure = 'CODEC_MISSING' | 'HELPER_MISSING' | 'UNSUPPORTED' | 'TOO_LARGE_PIXELS' | 'CORRUPT' | 'TIMEOUT';
export type HeicRunResult = { ok: true; jpeg: Uint8Array } | { ok: false; code: HeicFailure };

export interface HelperProcess {
  stdin: { write(bytes: Uint8Array): void; end(): void };
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

export interface HelperSpawner {
  spawn(exePath: string, args: readonly string[]): HelperProcess;
}

export const HEIC_LIMITS = {
  maxPixels: MAX_DECODE_PIXELS,
  maxInputBytes: MAX_DECODE_INPUT_BYTES,
  timeoutMs: DECODE_TIMEOUT_MS,
} as const;

interface HeicLimits {
  maxPixels: number;
  maxInputBytes: number;
  timeoutMs: number;
}

const EXIT_CODES: Readonly<Record<number, HeicFailure>> = {
  2: 'CODEC_MISSING',
  3: 'UNSUPPORTED',
  4: 'TOO_LARGE_PIXELS',
  5: 'CORRUPT',
};

interface DecodeRequest {
  bytes: Uint8Array;
  maxLongEdge: number;
  keepOriginal?: { maxBytes: number };
}

interface RunnerOptions {
  exePath(): Promise<string | null>;
  spawner: HelperSpawner;
  timers: TimerPort;
  limits?: HeicLimits;
  log(code: string): void;
}

function validRequest(req: DecodeRequest): boolean {
  if (req.keepOriginal !== undefined) {
    return req.maxLongEdge === Infinity && Number.isSafeInteger(req.keepOriginal.maxBytes)
      && req.keepOriginal.maxBytes > 0 && req.keepOriginal.maxBytes <= MAX_MEDIA_BYTES;
  }
  return Number.isSafeInteger(req.maxLongEdge) && req.maxLongEdge > 0 && req.maxLongEdge <= MAX_DECODE_PIXELS;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

/** Runs the native helper one request at a time; no paths or caller-controlled strings enter the helper protocol. */
export function createHeicHelperRunner(deps: RunnerOptions): { run(req: DecodeRequest): Promise<HeicRunResult> } {
  const limits = deps.limits ?? HEIC_LIMITS;
  let queue = Promise.resolve();

  const runOne = async (req: DecodeRequest): Promise<HeicRunResult> => {
    if (req.bytes.byteLength === 0) return { ok: false, code: 'CORRUPT' };
    if (req.bytes.byteLength > limits.maxInputBytes) return { ok: false, code: 'UNSUPPORTED' };
    if (!validRequest(req)) return { ok: false, code: 'UNSUPPORTED' };

    let path: string | null;
    try { path = await deps.exePath(); } catch { return { ok: false, code: 'HELPER_MISSING' }; }
    if (path === null || path.length === 0) return { ok: false, code: 'HELPER_MISSING' };

    const args = req.keepOriginal === undefined
      ? ['--max-long-edge', String(req.maxLongEdge)]
      : ['--keep-original-max-bytes', String(req.keepOriginal.maxBytes)];
    let child: HelperProcess;
    try { child = deps.spawner.spawn(path, args); } catch { return { ok: false, code: 'HELPER_MISSING' }; }

    return await new Promise<HeicRunResult>((resolve) => {
      let settled = false;
      let outputBytes = 0;
      const chunks: Uint8Array[] = [];
      let timer: unknown;
      const finish = (result: HeicRunResult): void => {
        if (settled) return;
        settled = true;
        deps.timers.clearTimeout(timer);
        resolve(result);
      };
      timer = deps.timers.setTimeout(() => {
        child.kill();
        finish({ ok: false, code: 'TIMEOUT' });
      }, limits.timeoutMs);

      child.onStdout((chunk) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_MEDIA_BYTES) {
          child.kill();
          finish({ ok: false, code: 'TOO_LARGE_PIXELS' });
          return;
        }
        chunks.push(Uint8Array.from(chunk));
      });
      child.onExit((code, signal) => {
        if (settled) return;
        if (signal !== null || code === null) {
          deps.log('helper-crash');
          finish({ ok: false, code: 'CORRUPT' });
          return;
        }
        if (code !== 0) {
          const failure = EXIT_CODES[code];
          if (failure === undefined) {
            deps.log('helper-crash');
            finish({ ok: false, code: 'CORRUPT' });
          } else finish({ ok: false, code: failure });
          return;
        }
        const output = new Uint8Array(outputBytes);
        let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
        if (!isJpeg(output)) {
          deps.log('helper-crash');
          finish({ ok: false, code: 'CORRUPT' });
          return;
        }
        if (req.keepOriginal !== undefined && output.byteLength > req.keepOriginal.maxBytes) {
          finish({ ok: false, code: 'TOO_LARGE_PIXELS' });
          return;
        }
        finish({ ok: true, jpeg: output });
      });
      try {
        child.stdin.write(req.bytes);
        child.stdin.end();
      } catch {
        child.kill();
        deps.log('helper-crash');
        finish({ ok: false, code: 'CORRUPT' });
      }
    });
  };

  return {
    run(req) {
      const pending = queue.then(() => runOne(req), () => runOne(req));
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}
