import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const children = [];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const launch = (command, args) => {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
  children.push(child);
  child.on('exit', (code) => { if (code !== null && code !== 0) shutdown(code); });
  return child;
};
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

launch(npm, ['exec', '--', 'vite', 'build', '--watch', '-c', 'vite.electron.config.ts', '--mode', 'development']);
launch(process.execPath, ['scripts/build-electron.mjs', '--watch']);
for (let attempt = 0; attempt < 300; attempt += 1) {
  if (existsSync('dist-electron/renderer/index-electron.html') && existsSync('dist-electron/main/index.cjs') && existsSync('dist-electron/preload/index.cjs')) break;
  if (children.some((child) => child.exitCode !== null)) shutdown(1);
  await delay(200);
}
if (shuttingDown) process.exit(process.exitCode ?? 1);
if (!existsSync('dist-electron/renderer/index-electron.html')) throw new Error('Electron renderer did not build');
launch(npm, ['exec', '--', 'electron', '.']);
await new Promise((resolvePromise) => {
  for (const child of children) child.once('exit', resolvePromise);
});
shutdown(0);
