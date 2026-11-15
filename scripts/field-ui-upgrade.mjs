#!/usr/bin/env node
// scripts/field-ui-upgrade.mjs
//
// Mechanical re-read helper for upgrading @inspectorhub/field-ui in this app.
//
// The pin tests (src/field/field-ui-contract.test.ts, uploader-write-ahead.test.ts,
// batch-attach.test.ts) fail loudly when the installed version changes, which asks the
// upgrader to re-read the package's dist and confirm the photo-batch functions the app
// models did not change. This script does the mechanical part of that re-read:
//
//   1. downloads the old and new published dist bundles,
//   2. extracts the six functions the app's adapters/tests copy or model, and
//      DEFAULT_INSPECTION_PREFS, from both,
//   3. reports, per function, whether it is byte-identical or what changed, and a
//      structured diff of the default prefs,
//   4. checks the three version pins against the new version (and, with --write,
//      updates them),
//   5. warns if src/maestro-flows.test.ts hard-codes dist/index.js (the 0.10.1 split
//      moved the editor UI strings into a chunk file).
//
// It does NOT replace reading the diff. It tells you exactly which functions to read.
//
// Usage:
//   node scripts/field-ui-upgrade.mjs                 # old = installed, new = package.json range
//   node scripts/field-ui-upgrade.mjs --new 0.11.0    # old = installed, new = 0.11.0
//   node scripts/field-ui-upgrade.mjs --old 0.9.0 --new 0.10.1   # explicit pair
//   node scripts/field-ui-upgrade.mjs --new 0.11.0 --write        # also update the pins

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_JSON = join(ROOT, 'package.json');

// The functions the app's write-ahead and batch-attach models depend on, and that the pin
// tests assert against. Keep this list in sync with those tests.
const TRACKED_FUNCS = [
  'appendPhoto',
  'pushPendingPhoto',
  'upsertElement',
  'appendPendingPhoto',
  'orderPhotoBatch',
  'attachPhotoBatch',
];

const PIN_FILES = [
  'src/field/field-ui-contract.test.ts',
  'src/field/uploader-write-ahead.test.ts',
  'src/field/batch-attach.test.ts',
].map((p) => join(ROOT, p));

const MAESTRO_FLOW_TEST = join(ROOT, 'src/maestro-flows.test.ts');

function readInstalledVersion() {
  const p = join(ROOT, 'node_modules', '@inspectorhub', 'field-ui', 'package.json');
  if (!existsSync(p)) throw new Error('@inspectorhub/field-ui is not installed; run npm install first');
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

function readPinnedFromPackageJson() {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));
  const dep = pkg.dependencies?.['@inspectorhub/field-ui'] ?? pkg.devDependencies?.['@inspectorhub/field-ui'];
  if (!dep) throw new Error('@inspectorhub/field-ui is not a dependency in package.json');
  return dep;
}

function resolveVersion(spec) {
  // A bare version (e.g. 0.10.1) is returned as-is; a range (e.g. ~0.9.0) is resolved to
  // the concrete published version npm would install.
  if (/^\d+\.\d+\.\d+/.test(spec)) return spec;
  const out = execFileSync('npm', ['view', `@inspectorhub/field-ui@${spec}`, 'version', '--registry=https://registry.npmjs.org'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
  });
  return out.trim();
}

function packVersion(version) {
  const dir = mkdtempSync(join(tmpdir(), 'fui-'));
  const tarball = execFileSync('npm', ['pack', `@inspectorhub/field-ui@${version}`, '--registry=https://registry.npmjs.org', '--silent'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
  }).trim();
  execFileSync('tar', ['-xzf', tarball], { cwd: dir, stdio: 'ignore' });
  return join(dir, 'package', 'dist');
}

// Extract a top-level `function NAME(...) { ... }` from source, returning the full text
// including the signature, or null if not found.
function extractFunction(source, name) {
  const re = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  if (i === -1) return null;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return null;
}

// Extract DEFAULT_INSPECTION_PREFS as a real object, or null if it cannot be read.
function extractDefault(source) {
  const re = /DEFAULT_INSPECTION_PREFS\s*=\s*\{/g;
  const m = re.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(source.indexOf('{', m.index), i + 1);
        try {
          // The literal is plain JS object syntax (string/number/array literals).
          return new Function(`return (${literal});`)(); // eslint-disable-line no-new-func
        } catch {
          return { __unparseable: literal };
        }
      }
    }
  }
  return null;
}

// Concatenated source of every .js file in a dist dir (index + chunks), so a function that
// moved between files is still found.
function distSource(distDir) {
  const files = readdirSync(distDir).filter((f) => f.endsWith('.js'));
  return files.map((f) => readFileSync(join(distDir, f), 'utf8')).join('\n');
}

function deepDiff(a, b, path = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const pa = `${path}.${k}`;
    if (a?.[k] === b?.[k]) continue;
    if (typeof a?.[k] === 'object' && typeof b?.[k] === 'object' && a?.[k] && b?.[k]) out.push(...deepDiff(a[k], b[k], pa));
    else out.push(`${pa}: ${JSON.stringify(a?.[k])} -> ${JSON.stringify(b?.[k])}`);
  }
  return out;
}

function checkPins(newVersion, write) {
  const report = [];
  for (const file of PIN_FILES) {
    const text = readFileSync(file, 'utf8');
    let next = text;
    // field-ui-contract.test.ts exposes `const PINNED = '...'`.
    next = next.replace(/const PINNED = '[^']*'/g, `const PINNED = '${newVersion}'`);
    // uploader-write-ahead / batch-attach inline the version in the `it` title (the version is
    // followed by more text in the title, so only the version number is replaced).
    next = next.replace(/is modelled on field-ui \d+\.\d+\.\d+/g, `is modelled on field-ui ${newVersion}`);
    // The version pin is the `expect(manifest.version, ...).toBe('...')` assertion; scope the
    // replacement to that line so unrelated `.toBe('...')` calls are left alone.
    next = next.replace(/expect\(manifest\.version[^)]*\)\.toBe\('[^']*'\)/g, (m) =>
      m.replace(/\.toBe\('[^']*'\)/, `.toBe('${newVersion}')`),
    );
    const changed = next !== text;
    report.push({ file: basename(file), changed, hadPin: /PINNED|is modelled on field-ui|manifest\.version/.test(text) });
    if (write && changed) writeFileSync(file, next);
  }
  return report;
}

function checkMaestroDistRead() {
  if (!existsSync(MAESTRO_FLOW_TEST)) return null;
  const text = readFileSync(MAESTRO_FLOW_TEST, 'utf8');
  // Our fix reads every .js in dist; a hard-coded index.js path will miss a chunk split.
  const hardCoded = /dist',\s*'index\.js'/.test(text) || /dist\/index\.js/.test(text);
  return { hardCoded, readsAllJs: /filter\(\(name\) => name\.endsWith\('\.js'\)\)/.test(text) };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const write = args.includes('--write');
  const oldSpec = get('--old');
  const newSpec = get('--new');

  const installed = readInstalledVersion();
  const oldVersion = oldSpec ? resolveVersion(oldSpec) : installed;
  const newVersion = newSpec ? resolveVersion(newSpec) : resolveVersion(readPinnedFromPackageJson());

  console.log(`field-ui upgrade re-read: ${oldVersion} -> ${newVersion} (installed: ${installed})`);
  if (oldVersion === newVersion) {
    console.log('old and new are the same version; nothing to compare.');
    return;
  }

  const oldDist = packVersion(oldVersion);
  const newDist = packVersion(newVersion);
  const oldSrc = distSource(oldDist);
  const newSrc = distSource(newDist);

  console.log('\n--- tracked functions (byte-identical check) ---');
  let anyChanged = false;
  for (const fn of TRACKED_FUNCS) {
    const a = extractFunction(oldSrc, fn);
    const b = extractFunction(newSrc, fn);
    if (a && b) {
      if (a === b) console.log(`  ${fn}: identical`);
      else {
        anyChanged = true;
        console.log(`  ${fn}: CHANGED — re-read its body in both dist bundles`);
      }
    } else if (a || b) {
      anyChanged = true;
      console.log(`  ${fn}: present in only one version (old=${!!a}, new=${!!b}) — re-read`);
    } else {
      console.log(`  ${fn}: not found in either bundle`);
    }
  }

  console.log('\n--- DEFAULT_INSPECTION_PREFS ---');
  const da = extractDefault(oldSrc);
  const db = extractDefault(newSrc);
  if (da && db) {
    const diff = deepDiff(da, db);
    if (diff.length === 0) console.log('  identical');
    else {
      anyChanged = true;
      for (const line of diff) console.log(`  ${line}`);
    }
  } else {
    console.log('  could not parse in one or both bundles; re-read by hand');
  }

  console.log('\n--- version pins ---');
  const pinReport = checkPins(newVersion, write);
  for (const r of pinReport) {
    console.log(`  ${r.file}: ${r.changed ? (write ? 'updated' : 'OUT OF DATE') : 'current'} (pin present: ${r.hadPin})`);
  }

  const maestro = checkMaestroDistRead();
  console.log('\n--- maestro-flows text-origin check ---');
  if (!maestro) console.log('  src/maestro-flows.test.ts not found');
  else if (maestro.hardCoded) console.log('  WARNING: still hard-codes dist/index.js — will miss a chunk split');
  else if (maestro.readsAllJs) console.log('  reads every .js in dist (chunk-split safe)');
  else console.log('  reads dist but not via the all-.js pattern — check it');

  console.log(`\nSummary: ${anyChanged ? 'at least one modelled function or default changed — read the diff before bumping the pins' : 'modelled functions and defaults are unchanged'}.`);
  if (write) console.log('Pins updated where out of date. Re-read the changed functions before committing.');

  rmSync(dirname(oldDist), { recursive: true, force: true });
  rmSync(dirname(newDist), { recursive: true, force: true });
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
