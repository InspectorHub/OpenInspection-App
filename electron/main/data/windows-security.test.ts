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
const directories = new Set([root, `${root}\\nested`]);

/** What `icacls <path>` prints once the final DACL is in place: the three trusted principals, nothing inherited. */
const finalAcl = (path: string, extra = ''): string => {
  const flags = directories.has(path) ? '(OI)(CI)(F)' : '(F)';
  const pad = ' '.repeat(path.length + 1);
  return `${path} NT AUTHORITY\\SYSTEM:${flags}\n${pad}BUILTIN\\Administrators:${flags}\n${pad}localized account:${flags}\n${extra}\nSuccessfully processed 1 files; Failed processing 0 files\n`;
};

function aclHarness(options: { readAcl?: (path: string) => string | undefined } = {}) {
  const denies = new Set<string>();
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args: string[]): Promise<SecurityCommandResult> => {
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
      // The injected answers describe the state found at startup; once a repair command ran, the harness models the repaired state.
      const injected = calls.some((call) => call[0] === 'powershell.exe') ? undefined : options.readAcl?.(args[0]!);
      if (injected !== undefined) return { status: 0, stdout: injected, stderr: '' };
      const denied = denies.has(args[0]!);
      return { status: 0, stdout: `${args[0]}\n  ${denied ? 'Everyone:(DENY)(RD)\n  BUILTIN\\Users:(DENY)(RD)' : ''}`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  return { calls, denies, run };
}

const powershellCalls = (calls: string[][], mode: 'barrier' | 'final'): string[][] => calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes(`$mode = '${mode}'`));

describe('Windows secrets boundary', () => {
  it('repairs every file after an injected partial ReadData barrier runner failure', async () => {
    const { calls, denies, run } = aclHarness();
    const partialRunner = async (files: readonly { path: string; directory: boolean }[], apply: (file: { path: string; directory: boolean }) => Promise<SecurityCommandResult>): Promise<SecurityCommandResult> => {
      expect(files.map((file) => file.path)).toEqual([`${root}\\root.secret`, `${root}\\nested\\nested.secret`, `${root}\\nested\\second.secret`]);
      expect(await apply(files[0]!)).toMatchObject({ status: 0 });
      return { status: 5, stdout: '', stderr: 'injected partial barrier runner failure' };
    };
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, barrierRunner: partialRunner });

    expect(denies.size).toBe(0);
    const barrierCalls = powershellCalls(calls, 'barrier');
    expect(barrierCalls).toHaveLength(3);
    expect(barrierCalls.map((call) => call[4])).toEqual(expect.arrayContaining([
      expect.stringContaining("$readData = [System.Security.AccessControl.FileSystemRights]::ReadData"),
    ]));
    expect(calls.filter((call) => call[0] === 'icacls.exe' && call.includes('/deny'))).toHaveLength(0);
    expect(powershellCalls(calls, 'final')).toHaveLength(5);
  });

  it('normalizes and verifies each object on success', async () => {
    const { calls, denies, run } = aclHarness();
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries });
    expect(calls.some((call) => call[0] === 'powershell.exe' && call[4]?.includes(`${root}\\nested\\nested.secret`) && call[4]?.includes('S-1-5-21-123-456-789-1001'))).toBe(true);
    expect(files.every((path) => !denies.has(path))).toBe(true);
  });

  it('spawns only read-only icacls queries when every object already has the final DACL', async () => {
    const { calls, run } = aclHarness({ readAcl: (path) => finalAcl(path) });
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries });
    expect(calls.filter((call) => call[0] === 'powershell.exe')).toHaveLength(0);
    expect(calls.filter((call) => call[0] === 'icacls.exe').map((call) => call[1]).sort()).toEqual([...files].sort());
    expect(calls.every((call) => call[0] === 'whoami.exe' || (call[0] === 'icacls.exe' && call.length === 2))).toBe(true);
  });

  it('still repairs and verifies the whole tree when a single object is not in the final state', async () => {
    const stale = `${root}\\nested\\second.secret`;
    const { calls, denies, run } = aclHarness({ readAcl: (path) => (path === stale ? undefined : finalAcl(path)) });
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries });
    expect(powershellCalls(calls, 'barrier')).toHaveLength(3);
    expect(powershellCalls(calls, 'final')).toHaveLength(5);
    expect(denies.size).toBe(0);
  });

  it.each([
    ['an extra principal with full control', (path: string) => finalAcl(path, `${' '.repeat(path.length + 1)}Contoso\\someone:${directories.has(path) ? '(OI)(CI)(F)' : '(F)'}`)],
    ['a broad principal', (path: string) => finalAcl(path, `${' '.repeat(path.length + 1)}Everyone:(F)`)],
    ['an inherited entry', (path: string) => finalAcl(path).replace(':(F)', ':(I)(F)').replace(':(OI)(CI)(F)', ':(I)(OI)(CI)(F)')],
    ['a deny entry', (path: string) => finalAcl(path, `${' '.repeat(path.length + 1)}localized account:(DENY)(W)`)],
    ['a narrower right than full control', (path: string) => finalAcl(path).replace('localized account:(F)', 'localized account:(M)').replace('localized account:(OI)(CI)(F)', 'localized account:(OI)(CI)(M)')],
    ['a missing trusted principal', (path: string) => finalAcl(path).replace(/BUILTIN\\Administrators:[^\n]*\n/, '')],
    ['an unreadable answer', () => 'garbage'],
  ])('does not treat %s as the final state', async (_label, output) => {
    const { calls, run } = aclHarness({ readAcl: (path) => (path === `${root}\\root.secret` ? output(path) : finalAcl(path)) });
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries });
    expect(powershellCalls(calls, 'final').length).toBeGreaterThan(0);
  });

  it('fails closed when the final DACL cannot be verified', async () => {
    const { run } = aclHarness();
    const inner = run.getMockImplementation()!;
    let finalApplied = false;
    run.mockImplementation(async (command, args) => {
      if (command === 'powershell.exe' && args[3]?.includes("$mode = 'final'")) finalApplied = true;
      if (finalApplied && command === 'icacls.exe' && args.length === 1) return { status: 0, stdout: `${args[0]}\n  Everyone:(F)\n`, stderr: '' };
      return inner(command, args);
    });
    await expect(secureSecretsAcl({ dir: root, run, listPaths: async () => entries })).rejects.toThrow('secrets-acl-failed');
  });

  it('recognizes all reparse tags through fsutil, not only symbolic links', async () => {
    const run = vi.fn(async (): Promise<SecurityCommandResult> => ({ status: 0, stdout: 'Reparse Tag Value : 0xa0000003', stderr: '' }));
    await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run }))
      .rejects.toThrow('secrets-reparse-point');
    expect(run).toHaveBeenCalledWith('fsutil.exe', ['reparsepoint', 'query', root]);
  });

  it('accepts only fsutil stdout Error 4390 diagnostics with a failing exit status', async () => {
    const run = vi.fn(async (): Promise<SecurityCommandResult> => ({ status: 1, stdout: 'Error 4390 (0x00001126): Not a reparse point', stderr: '' }));
    await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run })).resolves.toBeUndefined();
    const statusZero = vi.fn(async (): Promise<SecurityCommandResult> => ({ status: 0, stdout: 'Error 4390: misleading', stderr: '' }));
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
      const run = vi.fn(async (): Promise<SecurityCommandResult> => result);
      await expect(assertNotReparsePoint({ path: root, isSymbolicLink: false, run }))
        .rejects.toThrow('secrets-reparse-check-failed');
    }
  });
});
