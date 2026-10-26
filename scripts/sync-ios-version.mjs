// Keeps the iOS version in step with package.json, the one source of the app version.
//
//   node scripts/sync-ios-version.mjs [--build-number N]   write MARKETING_VERSION (and CURRENT_PROJECT_VERSION with N)
//   node scripts/sync-ios-version.mjs --check              fail if the project carries a different MARKETING_VERSION
//   --root <dir>                                           read and write under <dir> instead of the repository (tests)
//
// Capacitor's build command takes no build settings, so the Xcode project has to carry the literal. This script is the only
// thing that writes it, and a test (src/ios-version.test.ts) fails when it differs from package.json. iOS accepts only
// major.minor.patch for CFBundleShortVersionString, so a pre-release suffix is dropped here; the release workflow requires the
// tag to equal package.json's version exactly, and App Store Connect tells builds of one version apart by CURRENT_PROJECT_VERSION.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VERSION = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/;
// The project may carry CRLF line endings; the optional CR is captured and written back so a rewrite keeps the file's own.
const MARKETING = /^(\s*MARKETING_VERSION = )([^;]*);(\r?)$/gm;
const BUILD = /^(\s*CURRENT_PROJECT_VERSION = )([^;]*);(\r?)$/gm;

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const ROOT = rootAt === -1 ? resolve(import.meta.dirname, '..') : resolve(args[rootAt + 1] ?? '');
const check = args.includes('--check');
const buildAt = args.indexOf('--build-number');
const build = buildAt === -1 ? null : args[buildAt + 1];

function fail(message) {
  console.error(`sync-ios-version: ${message}`);
  process.exit(1);
}

if (build !== null && !/^[1-9][0-9]{0,8}$/.test(build ?? '')) fail('--build-number must be a whole number from 1 to 999999999 without leading zeros');

const PROJECT = join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const match = typeof pkg.version === 'string' ? VERSION.exec(pkg.version) : null;
if (match === null) fail(`package.json version '${String(pkg.version)}' is not major.minor.patch with an optional -prerelease`);
const marketing = match[1];

const text = readFileSync(PROJECT, 'utf8');
const found = [...text.matchAll(MARKETING)];
// Debug and Release of the one app target: finding none or one would pass for the wrong reason.
if (found.length !== 2) fail(`expected 2 MARKETING_VERSION settings in the project, found ${String(found.length)}`);

if (check) {
  const wrong = found.filter((m) => m[2] !== marketing);
  if (wrong.length > 0) fail(`the project has a MARKETING_VERSION other than ${marketing}; run node scripts/sync-ios-version.mjs`);
  console.log(`sync-ios-version: ${String(found.length)} MARKETING_VERSION settings match ${marketing}`);
  process.exit(0);
}

let next = text.replace(MARKETING, `$1${marketing};$3`);
if (build !== null) {
  if ([...next.matchAll(BUILD)].length !== 2) fail('expected 2 CURRENT_PROJECT_VERSION settings in the project');
  next = next.replace(BUILD, `$1${build};$3`);
}
if (next !== text) writeFileSync(PROJECT, next);
console.log(`sync-ios-version: MARKETING_VERSION ${marketing}${build === null ? '' : `, CURRENT_PROJECT_VERSION ${build}`}`);
