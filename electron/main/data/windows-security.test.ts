import { describe, expect, it, vi } from 'vitest';
import { secureSecretsAcl, assertNotReparsePoint, type SecurityCommandResult } from './windows-security.ts';

const root = 'C:\\user-data\\secrets';
const entries = [
  { path: `${root}\\root.secret`, directory: false },
  { path: `${root}\\nested`, directory: true },
  { path: `${root}\\nested\\nested.secret`, directory: false },
  { path: `${root}\\nested\\second.secret`, directory: false },
];
const files = [root, ...entries.map((entry) => entry.path)];

function aclHarness() {
  const denies = new Set<string>();
  const calls: string[][] = [];
  const run = vi.fn((command: string, args: string[]): SecurityCommandResult => {
    calls.push([command, ...args]);
    if (command === 'whoami.exe') return { status: 0, stdout: '"localized account" "S-1-5-21-123-456-789-1001"', stderr: '' };
    if (command === 'powershell.exe') {
      const script = args[3] ?? '';
      const path = files.find((candidate) => script.includes(`$path = '${candidate}'`));
      if (path) {
        if (script.includes("$mode = 'barrier'")) denies.add(path);
        else denies.delete(path);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command !== 'icacls.exe') return { status: 1, stdout: '', stderr: '' };
    if (args.length === 1) {
      const denied = denies.has(args[0]!);
      return { status: 0, stdout: `${args[0]}\n  ${denied ? 'Everyone:(DENY)(RD)\n  BUILTIN\\Users:(DENY)(RD)' : ''}`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  return { calls, denies, run };
}

describe('Windows secrets boundary', () => {
  it('repairs every file after an injected partial ReadData barrier runner failure', async () => {
    const { calls, denies, run } = aclHarness();
    const partialRunner = (files: readonly { path: string; directory: boolean }[], apply: (file: { path: string; directory: boolean }) => SecurityCommandResult): SecurityCommandResult => {
      expect(files.map((file) => file.path)).toEqual([`${root}\\root.secret`, `${root}\\nested\\nested.secret`, `${root}\\nested\\second.secret`]);
      expect(apply(files[0]!)).toMatchObject({ status: 0 });
      return { status: 5, stdout: '', stderr: 'injected partial barrier runner failure' };
    };
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, barrierRunner: partialRunner });

    expect(denies.size).toBe(0);
    const barrierCalls = calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes("$mode = 'barrier'"));
    expect(barrierCalls).toHaveLength(3);
    expect(barrierCalls.map((call) => call[4])).toEqual(expect.arrayContaining([
      expect.stringContaining("$readData = [System.Security.AccessControl.FileSystemRights]::ReadData"),
    ]));
    expect(calls.filter((call) => call[0] === 'icacls.exe' && call.includes('/deny'))).toHaveLength(0);
    expect(calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes("$mode = 'final'"))).toHaveLength(5);
  });

  it('normalizes and verifies each object on success', async () => {
    const { calls, denies, run } = aclHarness();
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries });
    expect(calls.some((call) => call[0] === 'powershell.exe' && call[4]?.includes(`${root}\\nested\\nested.secret`) && call[4]?.includes('S-1-5-21-123-456-789-1001'))).toBe(true);
    expect(files.every((path) => !denies.has(path))).toBe(true);
  });

  it('recognizes all reparse tags through fsutil, not only symbolic links', async () => {
    const run = vi.fn((): SecurityCommandResult => ({ status: 0, stdout: 'Reparse Tag Value : 0xa0000003', stderr: '' }));
    await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run }))
      .rejects.toThrow('secrets-reparse-point');
    expect(run).toHaveBeenCalledWith('fsutil.exe', ['reparsepoint', 'query', root]);
  });

  it('accepts only fsutil stdout Error 4390 diagnostics with a failing exit status', async () => {
    const run = vi.fn((): SecurityCommandResult => ({ status: 1, stdout: 'Error 4390 (0x00001126): Not a reparse point', stderr: '' }));
    await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run })).resolves.toBeUndefined();
    const statusZero = vi.fn((): SecurityCommandResult => ({ status: 0, stdout: 'Error 4390: misleading', stderr: '' }));
    await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run: statusZero }))
      .rejects.toThrow('secrets-reparse-point');
  });

  it('fails closed when a path or a different error contains a bare 4390', async () => {
    for (const result of [
      { status: 1, stdout: '', stderr: `Error 5: access denied for ${root} (4390)` },
      { status: 1, stdout: `${root}: failed with code 4390`, stderr: '' },
      { status: 1, stdout: 'Error 5: other failure', stderr: 'Error 4390: irrelevant stderr text' },
      { status: null, stdout: 'Error 4390: not a reparse point', stderr: '' },
      { status: -1, stdout: 'Error 4390: not a reparse point', stderr: '' },
    ]) {
      const run = vi.fn((): SecurityCommandResult => result);
      await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run }))
        .rejects.toThrow('secrets-reparse-check-failed');
    }
  });
});
