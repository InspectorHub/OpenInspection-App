import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as asar from '@electron/asar';

const FUSES = new Map([
  ['RunAsNode', 'Disabled'],
  ['EnableNodeOptionsEnvironmentVariable', 'Disabled'],
  ['EnableNodeCliInspectArguments', 'Disabled'],
  ['OnlyLoadAppFromAsar', 'Enabled'],
  ['EnableEmbeddedAsarIntegrityValidation', 'Enabled'],
]);
const WINDOWS_AUTH_ENV = process.platform === 'win32' ? {
  ...process.env,
  PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules',
} : process.env;

function fail(code) { throw new Error(`electron-package:${code}`); }

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function verifyFuseOutput(output) {
  for (const [name, expected] of FUSES) {
    const pattern = new RegExp(`\\b${name}(?:\\s+is)?\\s*[:=]?\\s*${expected}\\b`, 'i');
    if (!pattern.test(output)) fail(`fuse-${name}`);
  }
}

export function checkElectronPackage({ packageRoot = 'release-win', runFuses = (exe) => execFileSync(process.execPath, [resolve('node_modules/@electron/fuses/dist/bin.js'), 'read', '--app', exe], { encoding: 'utf8' }), signing = process.env.OI_WINDOWS_SIGNING ?? 'none', authenticode = (file) => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}').Status`], { encoding: 'utf8', env: WINDOWS_AUTH_ENV }).trim();
  return output;
} } = {}) {
  const appRoot = packageRoot.toLowerCase().endsWith('win-unpacked') ? packageRoot : join(packageRoot, 'win-unpacked');
  const resources = join(appRoot, 'resources');
  const archive = join(resources, 'app.asar');
  const executable = join(appRoot, 'InspectorHub.exe');
  if (!existsSync(archive) || !existsSync(executable)) fail('app-layout');
  const paths = asar.listPackage(archive, { isPack: false }).map((path) => path.replaceAll('\\', '/').replace(/^\/+/, ''));
  const required = ['dist-electron/main/index.cjs', 'dist-electron/preload/index.cjs', 'dist-electron/renderer/index-electron.html', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'];
  if (required.some((path) => !paths.includes(path))) fail('missing-app-entry');
  if (paths.some((path) => /(?:^|\/)node_modules\/(?:@capacitor|react|@inspectorhub\/field-ui)(?:\/|$)/i.test(path))) fail('duplicate-renderer-dependencies');

  const unpacked = join(resources, 'app.asar.unpacked');
  const nativeModules = walk(unpacked).filter((path) => path.toLowerCase().endsWith('.node'));
  if (nativeModules.some((path) => !/better-sqlite3-multiple-ciphers[\\/]prebuilds[\\/]win32-x64(?:[\\/]|\.node$)/i.test(path))) fail('foreign-native-module');
  const helper = join(resources, 'heic-helper', 'win-heic-helper.exe');
  if (!existsSync(helper) || paths.some((path) => /(?:^|\/)resources\/heic-helper\//i.test(path))) fail('helper-location');

  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const expectedHash = metadata?.oiHeicHelperSha256;
  if (typeof expectedHash !== 'string' || createHash('sha256').update(readFileSync(helper)).digest('hex') !== expectedHash.toLowerCase()) fail('helper-hash');

  const allAppFiles = [...paths.map((path) => `asar/${path}`), ...walk(unpacked).map((path) => `unpacked/${relative(unpacked, path)}`), ...walk(resources).map((path) => `resources/${relative(resources, path)}`)];
  if (allAppFiles.some((path) => /libheif|libde265|\.wasm$|heic-worker\.js|(?:^|[\\/])(?:lgpl|gpl)(?:[-_. ]|$)/i.test(path))) fail('forbidden-codec-artifact');
  const noticeFiles = [
    ...paths.filter((path) => /\.(?:txt|md|html)$/i.test(path)).map((path) => asar.extractFile(archive, path.replaceAll('/', '\\')).toString('utf8')),
    ...walk(resources).filter((path) => /\.(?:txt|md|html)$/i.test(path)).map((path) => readFileSync(path, 'utf8')),
  ];
  if (noticeFiles.some((text) => /GNU Lesser General Public License|\bLGPL\b|GNU General Public License|\bGPL(?:-?\d|v[123])\b/i.test(text))) fail('forbidden-codec-license');

  verifyFuseOutput(runFuses(executable));
  const signed = signing === 'azure';
  const expectedSignature = signed ? 'Valid' : 'NotSigned';
  for (const file of [executable, helper]) if (authenticode(file) !== expectedSignature) fail('authenticode');

  const installers = walk(packageRoot).filter((path) => /InspectorHub-Setup-.*\.exe$/i.test(path));
  if (installers.some((path) => statSync(path).size > 150 * 1024 * 1024)) fail('installer-too-large');
  const latest = join(packageRoot, 'latest.yml');
  if (existsSync(latest)) {
    const text = readFileSync(latest, 'utf8');
    const path = /^path:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!path || !installers.some((installer) => installer.endsWith(path))) fail('latest-yml-path');
  }
  return { archive, helper, executable, nativeModules: nativeModules.length, installers: installers.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkElectronPackage();
    process.stdout.write(`Windows package verified: ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'electron-package:unknown'}\n`);
    process.exitCode = 1;
  }
}
