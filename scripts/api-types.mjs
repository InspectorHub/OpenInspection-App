// Generates src/api/schema.d.ts from the engine's native contract.
//
//   OPENINSPECTION_CONTRACT=<path or URL> npm run api:types
//   npm run api:types -- <path or URL>
//   npm run api:types:check            (regenerates to a temp file, fails on drift)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const source = args.find((a) => !a.startsWith('--')) ?? process.env.OPENINSPECTION_CONTRACT;

if (!source) {
  console.error('Set OPENINSPECTION_CONTRACT or pass the contract path/URL as an argument.');
  process.exit(2);
}

const target = 'src/api/schema.d.ts';
const dir = check ? mkdtempSync(join(tmpdir(), 'api-types-')) : null;
const out = dir ? join(dir, 'schema.d.ts') : target;

const run = spawnSync('npx', ['openapi-typescript', source, '-o', out], { stdio: 'inherit', shell: true });
if (run.status !== 0) {
  if (dir) rmSync(dir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

if (dir) {
  const fresh = readFileSync(out, 'utf8');
  const committed = readFileSync(target, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  if (fresh !== committed) {
    console.error(`${target} is out of date with the contract. Run \`npm run api:types\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${target} matches the contract.`);
}
