// Fails when a release bundle still carries development-only UI.
//
//   npm run build && npm run check:bundle
//   node scripts/check-release-bundle.mjs [dist-directory]
//
// The plain-http switch on the server screen and the diagnostics screen are behind the build's own DEV flag, which the bundler
// replaces with a constant, so a release bundle must not contain their labels at all. This reads the
// built files, because a source test cannot see what the bundler kept.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// Development-only UI and the diagnostics screen: its button label, and the marker every check title and console line starts with.
// Then the test support that bypasses the plan brand, the purge authority and the data-layer block: no production module imports
// it (a source test pins that), and this catches what such an import would have put into the built files.
const FORBIDDEN = ['Allow plain http', 'Diagnostics (development only)', '[diag]', 'issuePlanForTest', 'purgeAuthorityForTest', 'neverBlocked'];
const SCANNED = new Set(['.js', '.mjs', '.css', '.html']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SCANNED.has(extname(name))) yield path;
  }
}

const dist = resolve(process.argv[2] ?? 'dist');
let files;
try {
  files = [...walk(dist)];
} catch {
  console.error(`check-release-bundle: cannot read ${dist}. Run the build first.`);
  process.exit(2);
}

// An empty scan would pass for the wrong reason, so it is an error of its own.
if (files.length === 0) {
  console.error(`check-release-bundle: no built files under ${dist}; nothing was checked.`);
  process.exit(2);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) hits.push(`${file}: contains "${needle}"`);
  }
}

console.log(`check-release-bundle: scanned ${String(files.length)} files, ${String(hits.length)} forbidden strings found.`);
if (hits.length > 0) {
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
