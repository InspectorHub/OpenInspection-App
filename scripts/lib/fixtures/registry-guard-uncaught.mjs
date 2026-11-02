// Run by registry-guard.test.ts as a CHILD PROCESS: changes the scratch key inside a guarded run, then dies from an uncaught exception
// raised outside the awaited chain. Only the guard's `exit` handler can put the key back from there.
//   node registry-guard-uncaught.mjs <lock dir> <backup dir>
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SCRATCH_KEY, withRegistryGuard } from '../registry-guard.mjs';

const [lockDir, backupDir] = process.argv.slice(2);
const reg = (...args) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), args, { stdio: 'ignore', windowsHide: true });

await withRegistryGuard([SCRATCH_KEY], () => {
  reg('add', SCRATCH_KEY, '/v', 'Probe', '/t', 'REG_SZ', '/d', 'changed by the child', '/f');
  reg('add', `${SCRATCH_KEY}\\added-by-child`, '/v', 'Added', '/t', 'REG_SZ', '/d', 'x', '/f');
  setTimeout(() => { throw new Error('uncaught, outside the awaited chain'); }, 50);
  return new Promise(() => undefined); // never settles: the normal flow can not be what restores the key
}, { lockDir, backupDir, log: () => undefined });
