#!/usr/bin/env node
// Pre-push guard: run the vitest files that import anything changed in the pushed range.
// The pre-commit hook type-checks but does not run vitest, so a shared-code change could reach CI red.
// Usage: git hook pre-push (stdin = push lines), or `node scripts/prepush-related-tests.mjs <file>...` to try a change list.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO = /^0+$/;
const SOURCE = /^(src|electron|e2e)\/.+\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
// A change here can break tests without touching a source file they import.
const CONFIG = /^(package\.json|package-lock\.json|vite[^/]*\.ts|vitest[^/]*|tsconfig[^/]*\.json|electron\/tsconfig[^/]*\.json|scripts\/[^/]+\.mjs)$/;
export const CONTRACT_TEST = 'src/field/field-ui-contract.test.ts';

const norm = (f) => f.replaceAll('\\', '/');

/** Changed paths worth feeding to `vitest related`: ts/tsx under src, electron and e2e. */
export function relatedCandidates(files) {
  return files.map(norm).filter((f) => SOURCE.test(f));
}

export function vitestArgs(files, jsonFile) {
  return ['related', '--run', '--passWithNoTests', '--no-file-parallelism', '--maxWorkers=1', '--reporter=default', '--reporter=json',
    `--outputFile.json=${jsonFile}`, ...files];
}

/** Parse git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. Deletions are dropped. */
export function parsePushLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue;
    out.push({ localSha, remoteSha: !remoteSha || ZERO.test(remoteSha) ? null : remoteSha });
  }
  return out;
}

/** `git diff -z --name-status` output: `S\0path\0` and `Rnn\0old\0new\0`. NUL separation keeps any file name intact. */
export function parseNameStatus(text) {
  const parts = text.split('\0');
  const changed = [];
  const deleted = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const [from, to] = [parts[i + 1], parts[i + 2]];
      if (status[0] === 'R' && from) deleted.push(from);
      if (to) changed.push(to);
      i += 2;
    } else {
      const path = parts[i + 1];
      if (path) (status[0] === 'D' ? deleted : changed).push(path);
      i += 1;
    }
  }
  return { changed, deleted };
}

/**
 * What to run for a change. `siblingsOf(dir)` lists file names in a directory (injected so it is testable).
 * Config and dependency changes always add the field-ui contract test; deleted sources add their own test files.
 */
export function classify({ changed, deleted }, siblingsOf) {
  const files = new Set(relatedCandidates(changed));
  const configChanged = changed.map(norm).filter((f) => CONFIG.test(f));
  for (const f of configChanged) if (f.startsWith('scripts/')) files.add(f);
  if (configChanged.length > 0) files.add(CONTRACT_TEST);
  const gone = new Set(deleted.map(norm));
  const deletedSource = relatedCandidates(deleted);
  for (const f of deletedSource) {
    const dir = posix.dirname(f);
    const stem = posix.basename(f).replace(/\.tsx?$/, '');
    for (const name of siblingsOf(dir)) {
      const path = `${dir}/${name}`;
      if (TEST_FILE.test(name) && name.startsWith(`${stem}.`) && !gone.has(path)) files.add(path);
    }
  }
  return { files: [...files], configChanged, deletedSource };
}

/** Two numbers plus the skipped count. Vitest counts skipIf and todo in the total, so they are not failures; an empty or all-skipped run is not green. */
export function summariseReport(report) {
  const files = report.testResults?.length ?? 0;
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  const green = files > 0 && passed > 0 && failed === 0 && (report.numFailedTestSuites ?? 0) === 0 && passed + skipped === total && report.success !== false;
  return { files, total, passed, failed, skipped, green };
}

export function baseFor({ localSha, remoteSha }, git) {
  if (remoteSha && git(['cat-file', '-e', `${remoteSha}^{commit}`]) !== null) return remoteSha;
  for (const ref of ['origin/main', 'main', 'origin/HEAD']) {
    const base = git(['merge-base', localSha, ref]);
    if (base) return base;
  }
  return null;
}

export function changedFiles(pushes, git) {
  const changed = new Set();
  const deleted = new Set();
  for (const push of pushes) {
    const base = baseFor(push, git);
    if (!base) return { error: `no base to compare ${push.localSha} against (no remote sha, no origin/main)` };
    const out = git(['-c', 'core.quotePath=false', 'diff', '-z', '--name-status', base, push.localSha]);
    if (out === null) return { error: `git diff ${base}..${push.localSha} failed` };
    const parsed = parseNameStatus(out);
    parsed.changed.forEach((f) => changed.add(f));
    parsed.deleted.forEach((f) => deleted.add(f));
  }
  return { changed: [...changed], deleted: [...deleted] };
}

/** The tests run on the working tree, so say where it differs from what is being pushed. */
export function treeProblems(pushes, head, porcelain) {
  const problems = [];
  for (const push of pushes) if (push.localSha !== head) problems.push(`pushed commit ${push.localSha} is not HEAD (${head}); the tests would run on HEAD's files`);
  if (porcelain.trim() !== '') problems.push('there are uncommitted changes to tracked files; the tests would run on them, not on what is pushed');
  return problems;
}

/** The whole decision, with every effect injected: git, vitest, directory listing, env, output. Returns the exit code. */
export function runGuard({ argv, stdin, env, git, vitest, listDir, log, err }) {
  const manual = argv.length > 0;
  let pushes = [];
  let changed;
  if (manual) changed = { changed: argv, deleted: [] };
  else {
    pushes = parsePushLines(stdin);
    changed = changedFiles(pushes, git);
  }
  if (changed.error) {
    err(`pre-push vitest: ${changed.error}. Refusing to guess; set OI_SKIP_PREPUSH_VITEST=1 only if this hook itself cannot run.`);
    return 1;
  }
  const plan = classify(changed, listDir);
  if (plan.deletedSource.length > 0) {
    err(`pre-push vitest: ${plan.deletedSource.length} deleted source file(s) not covered (a deleted file has no importers to follow; only its own sibling tests were added): ${plan.deletedSource.join(', ')}`);
  }
  if (plan.files.length === 0) {
    log(`pre-push vitest: SKIPPED, no ts/tsx under src/ electron/ e2e/, and no config or dependency file, changed (${changed.changed.length} changed file(s)).`);
    return 0;
  }
  if (env.OI_SKIP_PREPUSH_VITEST === '1') {
    err('!'.repeat(72));
    err('pre-push vitest: SKIPPED BY OI_SKIP_PREPUSH_VITEST=1. NOTHING WAS TESTED for these files:');
    for (const f of plan.files) err(`  ${f}`);
    err('CI is the only check left. Use this only when the hook itself cannot run.');
    err('!'.repeat(72));
    return 0;
  }
  if (!manual) {
    const head = git(['rev-parse', 'HEAD']) ?? '';
    const porcelain = git(['status', '--porcelain', '--untracked-files=no']) ?? '';
    const problems = treeProblems(pushes, head, porcelain);
    if (problems.length > 0) {
      err('!'.repeat(72));
      for (const p of problems) err(`pre-push vitest: REFUSED, ${p}.`);
      err('Push from a clean checkout of the commit you are pushing, or set OI_SKIP_PREPUSH_VITEST=1 to skip the tests (loudly).');
      err('!'.repeat(72));
      return 1;
    }
  }
  if (plan.configChanged.length > 0) {
    log(`pre-push vitest: ${plan.configChanged.join(', ')} changed, so the field-ui contract test runs too (a dependency or config change can break tests no import reveals; run \`npm test\` for the full suite).`);
  }
  log(`pre-push vitest: ${plan.files.length} file(s) to relate; running related tests serially.`);
  const { status, report } = vitest(plan.files);
  if (!report) {
    if (status === 0) {
      err('pre-push vitest: 0 test files run. NO TEST FILE is related to the changed sources; nothing verified them.');
      return 0;
    }
    err(`pre-push vitest: FAILED (vitest exit ${status}, no report; a crash).`);
    return 1;
  }
  const s = summariseReport(report);
  log(`pre-push vitest: ${s.files} test file(s) run, ${s.passed}/${s.total} tests passed, ${s.failed} failed, ${s.skipped} skipped.`);
  if (s.files === 0) err('pre-push vitest: NO TEST FILE is related to the changed sources. Nothing verified these changes.');
  if (s.files > 0 && s.passed === 0) err('pre-push vitest: every test was skipped; nothing was verified.');
  return s.green && status === 0 ? 0 : 1;
}

function realGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return args.includes('-z') ? r.stdout : r.stdout.trim();
}

function realVitest(files) {
  const dir = mkdtempSync(join(tmpdir(), 'oi-prepush-'));
  const jsonFile = join(dir, 'report.json');
  try {
    const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [vitest, ...vitestArgs(files, jsonFile)], { stdio: 'inherit' });
    let report = null;
    try { report = JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { /* none written */ }
    return { status: run.status ?? 1, report };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main() {
  let stdin = '';
  if (process.argv.length <= 2) { try { stdin = readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  return runGuard({
    argv: process.argv.slice(2), stdin, env: process.env, git: realGit, vitest: realVitest,
    listDir: (dir) => { try { return readdirSync(join(root, dir)); } catch { return []; } },
    log: (m) => console.log(m), err: (m) => console.error(m),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
