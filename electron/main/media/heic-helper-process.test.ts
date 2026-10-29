import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

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
});
