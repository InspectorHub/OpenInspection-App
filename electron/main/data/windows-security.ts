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

export async function secureSecretsAcl(input: {
  dir: string;
  run: SecurityCommand;
  listPaths: () => Promise<TreeEntry[]>;
  barrierRunner?: FileBarrierRunner;
}): Promise<void> {
  const entries = await input.listPaths();
  const allEntries: TreeEntry[] = [{ path: input.dir, directory: true }, ...entries];
  const fileEntries = entries.filter((entry) => !entry.directory);
  const acl = (path: string): Promise<SecurityCommandResult> => input.run('icacls.exe', [path]);
  const broadAce = /(?:Everyone|BUILTIN\\Users|S-1-1-0|S-1-5-32-545)/i;
  const hasBroadReadDataDeny = (output: string): boolean => {
    const lines = output.split(/\r?\n/);
    return ['Everyone|S-1-1-0', 'BUILTIN.*Users|S-1-5-32-545'].every((pattern) => {
      const sidOrName = new RegExp(pattern, 'i');
      return lines.some((line) => sidOrName.test(line) && /\(DENY\)/i.test(line)
        && /\(RD\)|\(ReadData\)|\(R,D\)/i.test(line));
    });
  };
  const hasBroadAce = (output: string): boolean => output.split(/\r?\n/).some((line) => broadAce.test(line));
  const verify = async (path: string, predicate: (output: string) => boolean): Promise<boolean> => {
    const result = await acl(path);
    return result.status === 0 && predicate(`${result.stdout}\n${result.stderr}`);
  };
  const identity = await input.run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const currentUserSid = identity.status === 0 ? identity.stdout.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0] : undefined;
  if (!currentUserSid) throw new Error('secrets-acl-failed');
  const currentUserName = /^\s*"([^"]+)"/.exec(identity.stdout)?.[1];

  // Every start finds the tree as the previous start left it. When each object already carries exactly the final
  // DACL, the barrier and the rewrite would only reproduce it, so the read-only queries are all that is needed. Any
  // answer that is not unmistakably that DACL (another principal, an inherited or deny entry, a narrower right, an
  // output this parser does not know, such as a localized principal name) falls through to the full repair below.
  const isFinalAcl = (entry: TreeEntry, output: string): boolean => {
    const lines = output.split(/\r?\n/);
    if (lines[0]?.toLowerCase().startsWith(entry.path.toLowerCase())) lines[0] = lines[0].slice(entry.path.length);
    const flags = entry.directory ? '(OI)(CI)(F)' : '(F)';
    const names: string[] = [];
    for (const line of lines) {
      if (line.trim() === '') break;
      const ace = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
      if (!ace || ace[2] !== flags) return false;
      names.push(ace[1]!.toLowerCase());
    }
    const trusted = [
      ['nt authority\\system', 's-1-5-18'],
      ['builtin\\administrators', 's-1-5-32-544'],
      [currentUserName?.toLowerCase() ?? '', currentUserSid.toLowerCase()],
    ];
    return names.length === trusted.length && trusted.every((identities) => names.filter((name) => identities.includes(name)).length === 1);
  };
  let alreadyFinal = true;
  for (const entry of allEntries) {
    if (!await verify(entry.path, (output) => isFinalAcl(entry, output))) { alreadyFinal = false; break; }
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
    if (result.status !== 0 || !await verify(entry.path, (output) => !hasBroadAce(output))) throw new Error('secrets-acl-failed');
  }
}
