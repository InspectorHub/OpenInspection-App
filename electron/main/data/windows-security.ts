import { join } from 'node:path';

export interface SecurityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SecurityCommand = (command: string, args: string[]) => Promise<SecurityCommandResult>;

export async function assertNotReparsePoint(input: {
  path: string;
  isSymbolicLink: boolean;
  run: SecurityCommand;
}): Promise<void> {
  const result = await input.run('fsutil.exe', ['reparsepoint', 'query', input.path]);
  if (result.status === 0) throw new Error('secrets-reparse-point');
  // fsutil writes this diagnostic to stdout. Do not accept a path or stderr
  // text that happens to contain the Win32 error number.
  if (result.status === null || result.status <= 0 || !/^\s*Error 4390(?:\s*\(0x0*1126\))?\s*:/im.test(result.stdout)) {
    throw new Error('secrets-reparse-check-failed');
  }
  if (input.isSymbolicLink) throw new Error('secrets-reparse-point');
}

type TreeEntry = { path: string; directory: boolean };
type FileBarrierRunner = (
  files: readonly TreeEntry[],
  applyBarrier: (file: TreeEntry) => Promise<SecurityCommandResult>,
) => Promise<SecurityCommandResult>;

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function setObjectAcl(input: {
  path: string;
  directory: boolean;
  currentUserSid: string;
  mode: 'barrier' | 'final';
  run: SecurityCommand;
}): Promise<SecurityCommandResult> {
  const { path, directory, currentUserSid, mode } = input;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$mode = '${mode}'`,
    `$path = ${quotePowerShell(path)}`,
    `$userSid = [System.Security.Principal.SecurityIdentifier]::new(${quotePowerShell(currentUserSid)})`,
    "$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
    "$adminSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
    "$everyoneSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    "$usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')",
    directory
      ? '$acl = New-Object System.Security.AccessControl.DirectorySecurity'
      : '$acl = New-Object System.Security.AccessControl.FileSecurity',
    '$acl.SetAccessRuleProtection($true, $false)',
    directory
      ? "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit"
      : '$inheritance = [System.Security.AccessControl.InheritanceFlags]::None',
    "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
    "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$readData = [System.Security.AccessControl.FileSystemRights]::ReadData",
    "if ($mode -eq 'barrier') {",
    "  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyoneSid, $readData, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Deny))",
    "  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, $readData, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Deny))",
    '}',
    'foreach ($sid in @($userSid, $systemSid, $adminSid)) {',
    '  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Allow))',
    '}',
    directory
      ? '[System.IO.Directory]::SetAccessControl($path, $acl)'
      : '[System.IO.File]::SetAccessControl($path, $acl)',
  ].join('; ');
  return input.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

/** The two principals that must never reach the secrets: Everyone and BUILTIN\Users, as SDDL alias and as full SID. */
const EVERYONE = ['wd', 's-1-1-0'];
const USERS = ['bu', 's-1-5-32-545'];
const READ_DATA = 0x1;

/** Access-mask tokens SDDL uses for file objects. ReadData (0x1) is printed as `CC`, the same bit. */
const RIGHTS: Readonly<Record<string, number>> = {
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
  SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000, FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
};

interface Ace { type: 'A' | 'D'; mask: number; trustee: string }

function parseMask(text: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (!/^(?:[A-Z]{2})+$/i.test(text)) return null;
  let mask = 0;
  for (const token of text.toUpperCase().match(/../g)!) {
    const bits = RIGHTS[token];
    if (bits === undefined) return null;
    mask |= bits;
  }
  return mask;
}

/** The access-control entries of a DACL-only SDDL string, or null for anything this parser does not know. */
function parseDacl(sddl: string): Ace[] | null {
  const parsed = /^D:(?:P|AI|AR)*((?:\([^()]*\))*)$/.exec(sddl);
  if (!parsed) return null;
  const aces: Ace[] = [];
  for (const match of parsed[1]!.matchAll(/\(([^()]*)\)/g)) {
    const fields = match[1]!.split(';');
    const type = fields[0];
    const mask = parseMask(fields[2] ?? '');
    const trustee = (fields[5] ?? '').toLowerCase();
    if (fields.length !== 6 || (type !== 'A' && type !== 'D') || mask === null || fields[3] !== '' || fields[4] !== '' || trustee === '') return null;
    aces.push({ type, mask, trustee });
  }
  return aces;
}

export async function secureSecretsAcl(input: {
  dir: string;
  run: SecurityCommand;
  listPaths: () => Promise<TreeEntry[]>;
  barrierRunner?: FileBarrierRunner;
  /** The object's DACL as one SDDL string, or null when it cannot be read. */
  readDacl: (path: string) => Promise<string | null>;
}): Promise<void> {
  const entries = await input.listPaths();
  const allEntries: TreeEntry[] = [{ path: input.dir, directory: true }, ...entries];
  const fileEntries = entries.filter((entry) => !entry.directory);
  const readDacl = input.readDacl;
  // Every check below reads the DACL as SDDL (see createSddlReader), so none of them depends on the Windows language.
  // A DACL that cannot be read or parsed never satisfies a check: the barrier is then unverified and the final state
  // is reported as failed, instead of passing because nothing recognisable was found.
  const verify = async (path: string, predicate: (aces: readonly Ace[]) => boolean): Promise<boolean> => {
    const sddl = await readDacl(path);
    const aces = sddl === null ? null : parseDacl(sddl);
    return aces !== null && predicate(aces);
  };
  const hasBroadReadDataDeny = (aces: readonly Ace[]): boolean =>
    [EVERYONE, USERS].every((aliases) => aces.some((ace) => ace.type === 'D' && (ace.mask & READ_DATA) !== 0 && aliases.includes(ace.trustee)));
  const hasNoBroadAce = (aces: readonly Ace[]): boolean => !aces.some((ace) => EVERYONE.includes(ace.trustee) || USERS.includes(ace.trustee));
  const identity = await input.run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const currentUserSid = identity.status === 0 ? identity.stdout.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0] : undefined;
  if (!currentUserSid) throw new Error('secrets-acl-failed');

  // Every start finds the tree as the previous start left it. When each object already carries exactly the final
  // DACL, the barrier and the rewrite would only reproduce it, so reading the DACLs is all that is needed. The
  // decision is made on SIDs (SDDL names no localized principal), so it holds on any Windows language. Any answer that
  // is not unmistakably that DACL (another principal, an inherited or deny entry, a narrower right, an output this
  // parser does not know) falls through to the full repair below.
  const finalTrustees = [['sy', 's-1-5-18'], ['ba', 's-1-5-32-544'], [currentUserSid.toLowerCase()]];
  const isFinalDacl = (entry: TreeEntry, sddl: string): boolean => {
    const parsed = /^D:P(?:AI)?((?:\([^()]*\))+)$/.exec(sddl);
    if (!parsed) return false;
    const inheritance = entry.directory ? 'oici' : '';
    const trustees: string[] = [];
    for (const ace of parsed[1]!.slice(1, -1).split(')(')) {
      const fields = ace.toLowerCase().split(';');
      if (fields.length !== 6 || fields[0] !== 'a' || fields[1] !== inheritance || fields[2] !== 'fa' || fields[3] !== '' || fields[4] !== '') return false;
      trustees.push(fields[5]!);
    }
    return trustees.length === finalTrustees.length
      && finalTrustees.every((aliases) => trustees.filter((trustee) => aliases.includes(trustee)).length === 1);
  };
  let alreadyFinal = true;
  for (const entry of allEntries) {
    if (!alreadyFinal) break;
    const sddl = await readDacl(entry.path);
    if (sddl === null || !isFinalDacl(entry, sddl)) alreadyFinal = false;
  }
  if (alreadyFinal) return;

  // Apply a precise ReadData barrier to each file. Tests may inject a runner
  // that applies the same real barrier to a subset and reports failure so the
  // repair path is exercised against a genuine partial ACL state.
  const applyBarrier = (entry: TreeEntry): Promise<SecurityCommandResult> =>
    setObjectAcl({ ...entry, currentUserSid, mode: 'barrier', run: input.run });
  const runBarriers = async (): Promise<SecurityCommandResult> => {
    let result: SecurityCommandResult = { status: 0, stdout: '', stderr: '' };
    for (const entry of fileEntries) {
      const next = await applyBarrier(entry);
      if (next.status !== 0) result = next;
    }
    return result;
  };
  const barrier = input.barrierRunner ? await input.barrierRunner(fileEntries, applyBarrier) : await runBarriers();
  for (const entry of fileEntries) {
    if (await verify(entry.path, hasBroadReadDataDeny)) continue;
    const result = await applyBarrier(entry);
    if (result.status !== 0 || !await verify(entry.path, hasBroadReadDataDeny)) throw new Error('secrets-acl-unverified');
  }
  if (barrier.status !== 0) {
    for (const entry of fileEntries) if (!await verify(entry.path, hasBroadReadDataDeny)) throw new Error('secrets-acl-unverified');
  }

  // Replace each DACL with a minimal trusted-principal ACL. This removes any
  // legacy broad allow/deny entries only after every existing file is denied
  // and verified. Directory inherit flags secure future descendants too.
  for (const entry of allEntries) {
    const result = await setObjectAcl({ ...entry, currentUserSid, mode: 'final', run: input.run });
    if (result.status !== 0 || !await verify(entry.path, hasNoBroadAce)) throw new Error('secrets-acl-failed');
  }
}

/**
 * Reads one object's DACL as SDDL. `icacls <path>` prints localized principal names and never SIDs, but
 * `icacls <path> /save <file>` records the DACL as SDDL (UTF-16, one name line and one SDDL line), which does not
 * depend on the Windows language. The tool's own messages are localized too, so only its exit status is used.
 */
export function createSddlReader(deps: {
  run: SecurityCommand;
  tempDir: string;
  newName: () => string;
  readFile: (path: string) => Promise<Uint8Array>;
  remove: (path: string) => Promise<void>;
}): (path: string) => Promise<string | null> {
  return async (path) => {
    const saved = join(deps.tempDir, `oi-dacl-${deps.newName()}.acl`);
    try {
      const result = await deps.run('icacls.exe', [path, '/save', saved]);
      if (result.status !== 0) return null;
      const bytes = await deps.readFile(saved);
      if (bytes.length % 2 !== 0) return null;
      const lines = new TextDecoder('utf-16le', { fatal: true }).decode(bytes).split(/\r?\n/).filter((line) => line !== '');
      return lines.length === 2 && lines[1]!.startsWith('D:') ? lines[1]! : null;
    } catch {
      return null;
    } finally {
      await deps.remove(saved).catch(() => undefined);
    }
  };
}
