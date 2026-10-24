// Fails when a release bundle still carries development-only UI.
//
//   npm run build && npm run check:bundle
//   node scripts/check-release-bundle.mjs [dist-directory]
//
// The plain-http switch on the server screen is behind the build's own DEV flag, which the bundler
// replaces with a constant, so a release bundle must not contain its label at all. This reads the
// built files, because a source test cannot see what the bundler kept.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const FORBIDDEN = ['Allow plain http'];
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
