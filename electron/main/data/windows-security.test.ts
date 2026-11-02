import { describe, expect, it, vi } from 'vitest';
import { secureSecretsAcl, assertNotReparsePoint, createSddlReader, type SecurityCommandResult } from './windows-security.ts';

const root = 'C:\\user-data\\secrets';
const entries = [
  { path: `${root}\\root.secret`, directory: false },
  { path: `${root}\\nested`, directory: true },
  { path: `${root}\\nested\\nested.secret`, directory: false },
  { path: `${root}\\nested\\second.secret`, directory: false },
];
const files = [root, ...entries.map((entry) => entry.path)];
const directories = new Set([root, `${root}\\nested`]);

const userSid = 'S-1-5-21-123-456-789-1001';
const aceFlags = (path: string): string => (directories.has(path) ? 'OICI' : '');

/** The DACL `icacls <path> /save` records once the final state is in place: protected, three trusted principals, full control. */
const finalSddl = (path: string, extra = ''): string =>
  `D:PAI(A;${aceFlags(path)};FA;;;SY)(A;${aceFlags(path)};FA;;;BA)(A;${aceFlags(path)};FA;;;${userSid})${extra}`;

/**
 * The DACL after the ReadData barrier, as `icacls <path> /save` recorded it on Windows 11 build 26300: the deny for
 * ReadData prints as `CC` (the same access bit, 0x1), Everyone is `WD` and BUILTIN\Users is `BU`.
 */
const barrierSddl = (path: string, omit = ''): string =>
  `D:PAI${[`(D;${aceFlags(path)};CC;;;WD)`, `(D;${aceFlags(path)};CC;;;BU)`].filter((ace) => !ace.endsWith(`;${omit})`)).join('')}`
  + `(A;${aceFlags(path)};FA;;;SY)(A;${aceFlags(path)};FA;;;BA)(A;${aceFlags(path)};FA;;;${userSid})`;

/** What the objects look like before any repair command ran, when no test says otherwise: nothing broad. */
const plainSddl = (): string => 'D:PAI(A;;FA;;;SY)';

function aclHarness(options: { afterBarrier?: (path: string) => string; afterFinal?: (path: string) => string } = {}) {
  const denies = new Set<string>();
  const applied = new Map<string, 'barrier' | 'final'>();
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args: string[]): Promise<SecurityCommandResult> => {
    calls.push([command, ...args]);
    if (command === 'whoami.exe') return { status: 0, stdout: `"localized account" "${userSid}"`, stderr: '' };
    if (command === 'powershell.exe') {
      const script = args[3] ?? '';
      const path = files.find((candidate) => script.includes(`$path = '${candidate}'`));
      if (path) {
        if (script.includes("$mode = 'barrier'")) { denies.add(path); applied.set(path, 'barrier'); }
        else { denies.delete(path); applied.set(path, 'final'); }
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command !== 'icacls.exe') return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });
  /** What the DACL reader answers: `initial` until a repair command touched the object, then the modelled state. */
  const answer = (initial?: (path: string) => string | null) => (path: string): string | null => {
    const state = applied.get(path);
    if (state === 'barrier') return (options.afterBarrier ?? barrierSddl)(path);
    if (state === 'final') return (options.afterFinal ?? finalSddl)(path);
    return initial ? initial(path) : plainSddl();
  };
  const readDacl = (initial?: (path: string) => string | null) => vi.fn(async (path: string): Promise<string | null> => answer(initial)(path));
  return { calls, denies, run, answer, readDacl };
}

const powershellCalls = (calls: string[][], mode: 'barrier' | 'final'): string[][] => calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes(`$mode = '${mode}'`));

describe('Windows secrets boundary', () => {
  it('repairs every file after an injected partial ReadData barrier runner failure', async () => {
    const { calls, denies, run, readDacl } = aclHarness();
    const partialRunner = async (files: readonly { path: string; directory: boolean }[], apply: (file: { path: string; directory: boolean }) => Promise<SecurityCommandResult>): Promise<SecurityCommandResult> => {
      expect(files.map((file) => file.path)).toEqual([`${root}\\root.secret`, `${root}\\nested\\nested.secret`, `${root}\\nested\\second.secret`]);
      expect(await apply(files[0]!)).toMatchObject({ status: 0 });
      return { status: 5, stdout: '', stderr: 'injected partial barrier runner failure' };
    };
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, barrierRunner: partialRunner, readDacl: readDacl() });

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
    const { calls, denies, run, readDacl } = aclHarness();
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: readDacl() });
    expect(calls.some((call) => call[0] === 'powershell.exe' && call[4]?.includes(`${root}\\nested\\nested.secret`) && call[4]?.includes('S-1-5-21-123-456-789-1001'))).toBe(true);
    expect(files.every((path) => !denies.has(path))).toBe(true);
  });

  it('spawns no repair and no display query when every object already has the final DACL', async () => {
    const harness = aclHarness();
    const { calls, run } = harness;
    const readDacl = harness.readDacl((path) => finalSddl(path));
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl });
    expect(readDacl.mock.calls.map(([path]) => path).sort()).toEqual([...files].sort());
    expect(calls.map((call) => call[0])).toEqual(['whoami.exe']);
  });

  it('accepts the trusted principals in any order, by SDDL alias or by full SID', async () => {
    const harness = aclHarness();
    const { calls, run } = harness;
    const readDacl = harness.readDacl((path) => `D:P(A;${aceFlags(path)};FA;;;${userSid.toLowerCase()})(A;${aceFlags(path)};FA;;;S-1-5-32-544)(A;${aceFlags(path)};FA;;;S-1-5-18)`);
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl });
    expect(powershellCalls(calls, 'final')).toHaveLength(0);
  });

  it('still repairs and verifies the whole tree when a single object is not in the final state', async () => {
    const stale = `${root}\\nested\\second.secret`;
    const harness = aclHarness();
    const { calls, denies, run } = harness;
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: harness.readDacl((path) => (path === stale ? null : finalSddl(path))) });
    expect(powershellCalls(calls, 'barrier')).toHaveLength(3);
    expect(powershellCalls(calls, 'final')).toHaveLength(5);
    expect(denies.size).toBe(0);
  });

  it.each([
    ['an extra principal with full control', (path: string) => finalSddl(path, `(A;${aceFlags(path)};FA;;;S-1-5-21-9-9-9-1234)`)],
    ['a broad principal', (path: string) => finalSddl(path, `(A;${aceFlags(path)};FA;;;WD)`)],
    ['an inherited entry', (path: string) => finalSddl(path).replace(`(A;${aceFlags(path)};FA;;;SY)`, `(A;${aceFlags(path)}ID;FA;;;SY)`)],
    ['a deny entry', (path: string) => finalSddl(path, `(D;${aceFlags(path)};FW;;;${userSid})`)],
    ['a narrower right than full control', (path: string) => finalSddl(path).replace(`;FA;;;${userSid}`, `;FW;;;${userSid}`)],
    ['a missing trusted principal', (path: string) => finalSddl(path).replace(`(A;${aceFlags(path)};FA;;;BA)`, '')],
    ['a trusted principal listed twice in place of another', (path: string) => finalSddl(path).replace(';;;BA)', ';;;SY)')],
    ['an unprotected DACL', (path: string) => finalSddl(path).replace('D:PAI', 'D:AI')],
    ['a SACL section', (path: string) => `${finalSddl(path)}S:AI(AU;SA;FA;;;WD)`],
    ['an object ACE', (path: string) => finalSddl(path).replace('(A;', '(OA;')],
    ['an unreadable answer', () => 'garbage'],
    ['an empty answer', () => ''],
  ])('does not treat %s as the final state', async (_label, output) => {
    const harness = aclHarness();
    const { calls, run } = harness;
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: harness.readDacl((path) => (path === `${root}\\root.secret` ? output(path) : finalSddl(path))) });
    expect(powershellCalls(calls, 'final').length).toBeGreaterThan(0);
  });

  it('does not treat a directory without inheritance flags, or a file with them, as final', async () => {
    const wrongOnes = [
      (path: string) => (directories.has(path) ? finalSddl(path).replaceAll('OICI', '') : finalSddl(path)),
      (path: string) => (directories.has(path) ? finalSddl(path) : finalSddl(path).replaceAll('(A;;', '(A;OICI;')),
    ];
    for (const wrong of wrongOnes) {
      const harness = aclHarness();
    const { calls, run } = harness;
      await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: harness.readDacl(wrong) });
      expect(powershellCalls(calls, 'final').length).toBeGreaterThan(0);
    }
  });

  it('repairs when no object can be read at the start', async () => {
    const harness = aclHarness();
    const { calls, run } = harness;
    await secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: harness.readDacl(() => null) });
    expect(powershellCalls(calls, 'final')).toHaveLength(5);
  });

  describe('reading the DACL as SDDL through icacls /save', () => {
    // The English text is what the real tool printed for `icacls <path> /save <file>` on Windows 11 build 26300; the
    // other two are the same message in the localized resources. Only the exit status and the saved file are used.
    const messages = {
      'en-US': 'processed file: C:\\x\nSuccessfully processed 1 files; Failed processing 0 files\n',
      'zh-CN': '\u5df2\u5904\u7406\u7684\u6587\u4ef6: C:\\x\n\u5df2\u6210\u529f\u5904\u7406 1 \u4e2a\u6587\u4ef6; \u5904\u7406 0 \u4e2a\u6587\u4ef6\u65f6\u5931\u8d25\n',
      'de-DE': 'Verarbeitete Datei: C:\\x\n1 Dateien erfolgreich verarbeitet; Fehler bei der Verarbeitung von 0 Dateien\n',
    };
    const locales = Object.keys(messages) as Array<keyof typeof messages>;

    function localizedHost(locale: keyof typeof messages, initial: (path: string) => string | null, harnessOptions: Parameters<typeof aclHarness>[0] = {}) {
      const written = new Map<string, Buffer>();
      const removed: string[] = [];
      const calls: string[][] = [];
      let sequence = 0;
      const base = aclHarness(harnessOptions);
      const run = async (command: string, args: string[]): Promise<SecurityCommandResult> => {
        calls.push([command, ...args]);
        if (command === 'whoami.exe') return { status: 0, stdout: `"DESKTOP\\${locale} user","${userSid}"\r\n`, stderr: '' };
        if (command === 'icacls.exe' && args[1] === '/save') {
          const text = base.answer(initial)(args[0]!);
          if (text === null) return { status: 2, stdout: '', stderr: messages[locale] };
          written.set(args[2]!, Buffer.from(`${args[0]!.split('\\').pop()}\r\n${text}\r\n`, 'utf16le'));
          return { status: 0, stdout: messages[locale], stderr: '' };
        }
        return base.run(command, args);
      };
      const readDacl = createSddlReader({
        run, tempDir: 'C:\\tmp', newName: () => `n${sequence++}`,
        readFile: async (path) => { const bytes = written.get(path); if (!bytes) throw new Error('missing'); return bytes; },
        remove: async (path) => { removed.push(path); written.delete(path); },
      });
      return { calls, run, readDacl, removed, written };
    }

    it.each(locales)('skips the repair on a %s host, whatever the localized principal names are', async (locale) => {
      const host = localizedHost(locale, (path) => finalSddl(path));
      await secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: host.readDacl });
      expect(host.calls.filter((call) => call[0] === 'powershell.exe')).toHaveLength(0);
      expect(host.calls.filter((call) => call[0] === 'icacls.exe').every((call) => call[2] === '/save')).toBe(true);
      expect(host.calls.filter((call) => call[0] === 'icacls.exe').map((call) => call[1]).sort()).toEqual([...files].sort());
      expect(host.removed).toHaveLength(files.length);
      expect(host.written.size).toBe(0);
    });

    it.each(locales)('repairs on a %s host when one object carries an extra principal', async (locale) => {
      const host = localizedHost(locale, (path) => finalSddl(path, path.endsWith('second.secret') ? '(A;;FA;;;WD)' : ''));
      await secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: host.readDacl });
      expect(host.calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes("$mode = 'final'"))).toHaveLength(5);
    });

    it.each(locales)('repairs a legacy broad ACL on a %s host and verifies the barrier and the final DACL', async (locale) => {
      const host = localizedHost(locale, (path) => finalSddl(path, `(A;${aceFlags(path)};FA;;;WD)(A;${aceFlags(path)};FA;;;BU)`));
      await secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: host.readDacl });
      expect(host.calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes("$mode = 'barrier'"))).toHaveLength(3);
      expect(host.calls.filter((call) => call[0] === 'powershell.exe' && call[4]?.includes("$mode = 'final'"))).toHaveLength(5);
      expect(host.written.size).toBe(0);
    });

    it.each(locales)('detects a barrier without the Users deny on a %s host', async (locale) => {
      const host = localizedHost(locale, () => plainSddl(), { afterBarrier: (path) => barrierSddl(path, 'BU') });
      await expect(secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: host.readDacl })).rejects.toThrow('secrets-acl-unverified');
    });

    it.each(locales)('detects a broad allow left in the final state on a %s host', async (locale) => {
      const host = localizedHost(locale, () => plainSddl(), { afterFinal: (path) => finalSddl(path, `(A;${aceFlags(path)};FA;;;BU)`) });
      await expect(secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: host.readDacl })).rejects.toThrow('secrets-acl-failed');
    });

    it.each(locales)('fails safe in both checks on a %s host when icacls /save fails', async (locale) => {
      const host = localizedHost(locale, () => plainSddl());
      const failing = createSddlReader({ run: async () => ({ status: 5, stdout: '', stderr: messages[locale] }), tempDir: 'C:\\tmp', newName: () => 'x', readFile: async () => Buffer.alloc(0), remove: async () => undefined });
      await expect(secureSecretsAcl({ dir: root, run: host.run, listPaths: async () => entries, readDacl: failing })).rejects.toThrow('secrets-acl-unverified');
    });

    it('answers null, and still removes its scratch file, when icacls fails', async () => {
      const failing = localizedHost('de-DE', () => null);
      expect(await failing.readDacl(root)).toBeNull();
      expect(failing.removed).toHaveLength(1);
    });

    it('answers null for a file that is not exactly one UTF-16 name line plus one SDDL line', async () => {
      for (const content of [Buffer.from('D:PAI(A;;FA;;;SY)', 'utf8'), Buffer.from('a\r\nD:PAI(A;;FA;;;SY)\r\nb\r\nD:PAI()\r\n', 'utf16le'), Buffer.from('a\r\nnot sddl\r\n', 'utf16le'), Buffer.alloc(0), Buffer.from([0x61])]) {
        const host = localizedHost('en-US', () => 'D:PAI(A;;FA;;;SY)');
        host.run = async () => ({ status: 0, stdout: '', stderr: '' });
        const readDacl = createSddlReader({ run: host.run, tempDir: 'C:\\tmp', newName: () => 'x', readFile: async () => content, remove: async () => undefined });
        expect(await readDacl(root)).toBeNull();
      }
    });

    it('reads the SDDL line of a well-formed file, with or without a byte order mark', async () => {
      const sddl = finalSddl(root);
      for (const bytes of [Buffer.from(`secrets\r\n${sddl}\r\n`, 'utf16le'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`secrets\r\n${sddl}\r\n`, 'utf16le')])]) {
        const readDacl = createSddlReader({ run: async () => ({ status: 0, stdout: '', stderr: '' }), tempDir: 'C:\\tmp', newName: () => 'x', readFile: async () => bytes, remove: async () => undefined });
        expect(await readDacl(root)).toBe(sddl);
      }
    });
  });

  describe('verifying the barrier and the final state from SDDL', () => {
    const repair = (options: Parameters<typeof aclHarness>[0]) => {
      const harness = aclHarness(options);
      return secureSecretsAcl({ dir: root, run: harness.run, listPaths: async () => entries, readDacl: harness.readDacl() });
    };
    const broad = (path: string, trustee: string, type = 'A', rights = 'FA'): string => `(${type};${aceFlags(path)};${rights};;;${trustee})`;

    it('accepts the barrier whatever way the ReadData deny is spelled (positive control for the negatives below)', async () => {
      await expect(repair({})).resolves.toBeUndefined();
      await expect(repair({ afterBarrier: (path) => `D:PAI(D;${aceFlags(path)};0x1;;;S-1-1-0)(D;${aceFlags(path)};0x1;;;S-1-5-32-545)(A;${aceFlags(path)};FA;;;SY)` })).resolves.toBeUndefined();
      await expect(repair({ afterBarrier: (path) => `D:PAI(D;${aceFlags(path)};CCLC;;;wd)(D;${aceFlags(path)};FR;;;bu)(A;${aceFlags(path)};FA;;;SY)` })).resolves.toBeUndefined();
    });

    it.each([
      ['the Users deny is missing', (path: string) => barrierSddl(path, 'BU')],
      ['the Everyone deny is missing', (path: string) => barrierSddl(path, 'WD')],
      ['the deny does not cover ReadData', (path: string) => barrierSddl(path).replace(';CC;;;BU)', ';SW;;;BU)')],
      ['the entry is an allow, not a deny', (path: string) => barrierSddl(path).replace('(D;', '(A;')],
      ['a deny names another principal', (path: string) => barrierSddl(path).replace(';CC;;;BU)', ';CC;;;SY)')],
      ['a rights token is unknown', (path: string) => barrierSddl(path).replace(';CC;;;BU)', ';ZZ;;;BU)')],
      ['the answer is garbage', () => 'garbage'],
      ['the answer is empty', () => ''],
      ['the answer has a SACL section', (path: string) => `${barrierSddl(path)}S:AI(AU;SA;FA;;;WD)`],
    ])('does not accept a barrier when %s', async (_label, afterBarrier) => {
      await expect(repair({ afterBarrier })).rejects.toThrow('secrets-acl-unverified');
    });

    it.each([
      ['an Everyone allow', (path: string) => finalSddl(path, broad(path, 'WD'))],
      ['an Everyone allow by full SID', (path: string) => finalSddl(path, broad(path, 'S-1-1-0'))],
      ['a Users allow', (path: string) => finalSddl(path, broad(path, 'BU'))],
      ['a Users allow by full SID', (path: string) => finalSddl(path, broad(path, 'S-1-5-32-545'))],
      ['a leftover Users deny', (path: string) => finalSddl(path, broad(path, 'BU', 'D', 'CC'))],
      ['an unknown rights token on a trusted principal', (path: string) => finalSddl(path).replace(';FA;;;BA)', ';ZZ;;;BA)')],
      ['garbage', () => 'garbage'],
      ['an empty answer', () => ''],
    ])('does not accept a final state with %s', async (_label, afterFinal) => {
      await expect(repair({ afterFinal })).rejects.toThrow('secrets-acl-failed');
    });
  });

  it('fails closed when the final DACL cannot be verified', async () => {
    const { run, readDacl } = aclHarness({ afterFinal: (path) => finalSddl(path, `(A;${aceFlags(path)};FA;;;WD)`) });
    await expect(secureSecretsAcl({ dir: root, run, listPaths: async () => entries, readDacl: readDacl() })).rejects.toThrow('secrets-acl-failed');
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
