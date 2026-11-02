import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { RELEASE_FORBIDDEN } from './bundle-forbidden.mjs';

const forbidden = ['@capacitor', 'Capacitor.', 'capacitor://', ...RELEASE_FORBIDDEN];
const scannedExtensions = new Set(['.js', '.mjs', '.css', '.html']);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (scannedExtensions.has(extname(name))) yield path;
  }
}

const renderer = resolve(process.argv[2] ?? 'dist-electron/renderer');
let files;
try { files = [...walk(renderer)]; }
catch {
  console.error(`check-electron-bundle: cannot read ${renderer}. Run the Electron renderer build first.`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`check-electron-bundle: no built files under ${renderer}; nothing was checked.`);
  process.exit(2);
}
const hits = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const needle of forbidden) if (content.includes(needle)) hits.push(`${file}: contains "${needle}"`);
}
console.log(`check-electron-bundle: scanned ${String(files.length)} files, ${String(hits.length)} forbidden strings found.`);
if (hits.length) {
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
