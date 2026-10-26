import { beforeEach, describe, expect, it } from 'vitest';
import type { CheckResult } from './checks/types';
import { formatLine, logResult, resetLog } from './log';

const RESULT: CheckResult = { id: 'db-blob', title: '[diag] db-blob', ok: true, status: 'pass', detail: 'blobs=3 platform=android' };

beforeEach(() => {
  resetLog();
});

describe('diagnostic log', () => {
  it('formats exactly [diag] <id> <ok> <detail>', () => {
    expect(formatLine(RESULT)).toBe('[diag] db-blob true blobs=3 platform=android');
    expect(formatLine({ ...RESULT, ok: false, status: 'fail' })).toBe('[diag] db-blob false blobs=3 platform=android');
  });

  it('writes to the sink and keeps the line on globalThis for a debugger to read', () => {
    const seen: string[] = [];
    logResult(RESULT, { info: (message) => seen.push(message) });
    expect(seen).toEqual(['[diag] db-blob true blobs=3 platform=android']);
    expect((globalThis as { __diagLog?: string[] }).__diagLog).toEqual(seen);
  });

  it('skips a line identical to the previous one for the same check, but not a changed one', () => {
    const seen: string[] = [];
    const sink = { info: (message: string) => seen.push(message) };
    logResult(RESULT, sink);
    logResult(RESULT, sink);
    logResult({ ...RESULT, detail: 'blobs=3 platform=ios' }, sink);
    logResult(RESULT, sink);
    expect(seen).toHaveLength(3);
  });

  it('keeps at most 500 lines', () => {
    const sink = { info: () => undefined };
    for (let i = 0; i < 520; i += 1) logResult({ ...RESULT, detail: `n=${String(i)}` }, sink);
    const kept = (globalThis as { __diagLog?: string[] }).__diagLog ?? [];
    expect(kept).toHaveLength(500);
    expect(kept[kept.length - 1]).toBe('[diag] db-blob true n=519');
  });
});
