import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_TEST, baseFor, changedFiles, classify, parseNameStatus, parsePushLines, relatedCandidates, runGuard, summariseReport,
  treeProblems, vitestArgs,
} from './prepush-related-tests.mjs';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
type Git = (args: string[]) => string | null;
const gitOf = (table: Record<string, string | null>): Git => (args) => (args.join(' ') in table ? (table[args.join(' ')] ?? null) : null);
const nul = (...parts: string[]): string => `${parts.join('\0')}\0`;
const DIFF = (base: string, head: string): string => `-c core.quotePath=false diff -z --name-status ${base} ${head}`;

describe('relatedCandidates', () => {
  it('keeps ts and tsx under src, electron and e2e, and nothing else', () => {
    expect(relatedCandidates([
      'src/export/copy.ts', 'src/ui/ExportFlow.tsx', 'electron/main/index.ts', 'e2e/flows/a.test.ts',
      'docs/development.md', 'package.json', 'android/app/build.gradle', 'src/styles/app.css', 'src/data.json',
      'scripts/check-release-bundle.mjs', 'src\\ui\\Win.tsx', 'src/é.ts',
    ])).toEqual(['src/export/copy.ts', 'src/ui/ExportFlow.tsx', 'electron/main/index.ts', 'e2e/flows/a.test.ts', 'src/ui/Win.tsx', 'src/é.ts']);
  });
});

describe('vitestArgs', () => {
  it('runs related files once, serially, with a json report, and no -- separator', () => {
    const args = vitestArgs(['src/a.ts', 'src/b.tsx'], '/tmp/r.json');
    expect(args.slice(0, 4)).toEqual(['related', '--run', '--passWithNoTests', '--no-file-parallelism']);
    expect(args).toContain('--maxWorkers=1');
    expect(args).toContain('--outputFile.json=/tmp/r.json');
    expect(args).not.toContain('--');
    expect(args.slice(-2)).toEqual(['src/a.ts', 'src/b.tsx']);
  });
});

describe('parsePushLines', () => {
  it('ignores deletions and treats an all-zero remote sha as a new branch', () => {
    const text = `refs/heads/x ${A} refs/heads/x ${ZERO}\nrefs/heads/gone ${ZERO} refs/heads/gone ${B}\n\n`;
    expect(parsePushLines(text)).toEqual([{ localSha: A, remoteSha: null }]);
    expect(parsePushLines(`refs/heads/x ${A} refs/heads/x ${B}`)).toEqual([{ localSha: A, remoteSha: B }]);
  });
});

describe('parseNameStatus (NUL separated, so odd names survive)', () => {
  it('splits added, modified, deleted and renamed, and keeps a non-ASCII path', () => {
    const text = nul('M', 'src/é.ts', 'A', 'src/new file.ts', 'D', 'src/gone.ts', 'R100', 'src/old.ts', 'src/renamed.ts');
    expect(parseNameStatus(text)).toEqual({
      changed: ['src/é.ts', 'src/new file.ts', 'src/renamed.ts'],
      deleted: ['src/gone.ts', 'src/old.ts'],
    });
  });
  it('is empty for empty output', () => expect(parseNameStatus('')).toEqual({ changed: [], deleted: [] }));
});

describe('classify', () => {
  const none = (): string[] => [];
  it('skips when only docs changed', () => {
    expect(classify({ changed: ['README.md'], deleted: [] }, none).files).toEqual([]);
  });
  it('a dependency or config change always adds the field-ui contract test, and says why', () => {
    for (const f of ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'electron/tsconfig.json']) {
      const plan = classify({ changed: [f], deleted: [] }, none);
      expect(plan.files, f).toEqual([CONTRACT_TEST]);
      expect(plan.configChanged, f).toEqual([f]);
    }
  });
  it('a changed script is related to the tests that import it', () => {
    const plan = classify({ changed: ['scripts/prepush-related-tests.mjs'], deleted: [] }, none);
    expect(plan.files).toEqual(['scripts/prepush-related-tests.mjs', CONTRACT_TEST]);
  });
  it('a deleted source file pulls in its sibling tests and is reported as not covered', () => {
    const plan = classify({ changed: [], deleted: ['src/ui/Gone.tsx', 'docs/x.md'] }, (dir) => (dir === 'src/ui' ? ['Gone.test.tsx', 'Gone.more.test.tsx', 'Other.test.tsx', 'Gone.tsx'] : []));
    expect(plan.files).toEqual(['src/ui/Gone.test.tsx', 'src/ui/Gone.more.test.tsx']);
    expect(plan.deletedSource).toEqual(['src/ui/Gone.tsx']);
  });
  it('does not run a sibling test that is itself deleted', () => {
    const plan = classify({ changed: [], deleted: ['src/a/x.ts', 'src/a/x.test.ts'] }, () => ['x.test.ts']);
    expect(plan.files).toEqual([]);
  });
});

describe('summariseReport (shape taken from a real vitest json run: numPendingTests counts skipIf)', () => {
  const real = { testResults: [{}, {}], numTotalTests: 11, numPassedTests: 10, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, numFailedTestSuites: 0, success: true };
  it('a skipped test is not a failure, and is the third number', () => {
    expect(summariseReport(real)).toEqual({ files: 2, total: 11, passed: 10, failed: 0, skipped: 1, green: true });
  });
  it('todo counts as skipped too', () => {
    expect(summariseReport({ ...real, numTotalTests: 12, numTodoTests: 1 }).skipped).toBe(2);
  });
  it('never calls an empty run green', () => {
    expect(summariseReport({ ...real, testResults: [], numTotalTests: 0, numPassedTests: 0, numPendingTests: 0 }).green).toBe(false);
  });
  it('a run where nothing but skips happened is not green', () => {
    expect(summariseReport({ ...real, numTotalTests: 3, numPassedTests: 0, numPendingTests: 3 }).green).toBe(false);
  });
  it('fails on a failed test or a failed suite (a file that cannot load has no failed test)', () => {
    expect(summariseReport({ ...real, numFailedTests: 1, numPassedTests: 9 }).green).toBe(false);
    expect(summariseReport({ ...real, numFailedTestSuites: 1 }).green).toBe(false);
  });
});

describe('baseFor and changedFiles', () => {
  it('uses the remote sha when it exists locally', () => {
    expect(baseFor({ localSha: A, remoteSha: B }, gitOf({ [`cat-file -e ${B}^{commit}`]: '' }))).toBe(B);
  });
  it('falls back to the merge-base with origin/main for a new branch, then main', () => {
    expect(baseFor({ localSha: A, remoteSha: null }, gitOf({ [`merge-base ${A} origin/main`]: 'mb1' }))).toBe('mb1');
    expect(baseFor({ localSha: A, remoteSha: B }, gitOf({ [`merge-base ${A} main`]: 'mb2' }))).toBe('mb2');
  });
  it('is null with nothing to compare against', () => expect(baseFor({ localSha: A, remoteSha: null }, gitOf({}))).toBeNull());

  it('asks git for NUL separated name-status and merges the pushes', () => {
    const git = gitOf({ [`merge-base ${A} origin/main`]: 'mb', [DIFF('mb', A)]: nul('M', 'src/é.ts', 'D', 'src/old.ts') });
    expect(changedFiles([{ localSha: A, remoteSha: null }], git)).toEqual({ changed: ['src/é.ts'], deleted: ['src/old.ts'] });
  });
  it('reports an error rather than guessing when there is no base or the diff fails', () => {
    expect(changedFiles([{ localSha: A, remoteSha: null }], gitOf({}))).toHaveProperty('error');
    expect(changedFiles([{ localSha: A, remoteSha: B }], gitOf({ [`cat-file -e ${B}^{commit}`]: '' }))).toHaveProperty('error');
  });
});

describe('treeProblems (the hook tests the working tree, not the pushed commit)', () => {
  it('is quiet when the push is HEAD and tracked files are clean', () => {
    expect(treeProblems([{ localSha: A, remoteSha: null }], A, '')).toEqual([]);
  });
  it('names a pushed sha that is not HEAD', () => {
    expect(treeProblems([{ localSha: A, remoteSha: null }], B, '')[0]).toMatch(/not HEAD/);
  });
  it('names uncommitted changes to tracked files', () => {
    expect(treeProblems([{ localSha: A, remoteSha: null }], A, ' M src/a.ts\n')[0]).toMatch(/uncommitted/);
  });
});

describe('runGuard', () => {
  const stdin = `refs/heads/x ${A} refs/heads/x ${B}\n`;
  const baseGit = (extra: Record<string, string | null> = {}): Git =>
    gitOf({
      [`cat-file -e ${B}^{commit}`]: '',
      [DIFF(B, A)]: nul('M', 'src/export/copy.ts'),
      'rev-parse HEAD': A,
      'status --porcelain --untracked-files=no': '',
      ...extra,
    });
  const okReport = { testResults: [{}], numTotalTests: 2, numPassedTests: 1, numPendingTests: 1, numFailedTests: 0, numTodoTests: 0, numFailedTestSuites: 0, success: true };
  const harness = (over: Partial<Parameters<typeof runGuard>[0]> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const vitest = vi.fn((_files: string[]) => ({ status: 0, report: okReport as object | null }));
    const deps = { argv: [] as string[], stdin, env: {} as Record<string, string | undefined>, git: baseGit(), vitest, listDir: (): string[] => [], log: (m: string) => out.push(m), err: (m: string) => err.push(m), ...over };
    return { deps, out, err, vitest };
  };

  it('runs related tests and prints files, passed/total and skipped', () => {
    const h = harness();
    expect(runGuard(h.deps)).toBe(0);
    expect(h.vitest).toHaveBeenCalledWith(['src/export/copy.ts']);
    expect(h.out.join('\n')).toMatch(/1 test file\(s\) run, 1\/2 tests passed, 0 failed, 1 skipped/);
  });
  it('fails the push on a red test', () => {
    const h = harness();
    h.vitest.mockReturnValue({ status: 1, report: { ...okReport, numFailedTests: 1, numPendingTests: 0, success: false } });
    expect(runGuard(h.deps)).toBe(1);
  });
  it('the no-report branch: exit 0 means nothing was related (loud, passes); a non-zero exit fails', () => {
    const ok = harness();
    ok.vitest.mockReturnValue({ status: 0, report: null });
    expect(runGuard(ok.deps)).toBe(0);
    expect(ok.err.join('\n')).toMatch(/NO TEST FILE/);
    const bad = harness();
    bad.vitest.mockReturnValue({ status: 1, report: null });
    expect(runGuard(bad.deps)).toBe(1);
  });
  it('OI_SKIP_PREPUSH_VITEST=1 skips loudly, naming the files, and runs nothing', () => {
    const h = harness({ env: { OI_SKIP_PREPUSH_VITEST: '1' } });
    expect(runGuard(h.deps)).toBe(0);
    expect(h.vitest).not.toHaveBeenCalled();
    expect(h.err.join('\n')).toMatch(/NOTHING WAS TESTED[\s\S]*src\/export\/copy\.ts/);
  });
  it('refuses when HEAD is not the pushed commit or tracked files are dirty', () => {
    const notHead = harness({ git: baseGit({ 'rev-parse HEAD': B }) });
    expect(runGuard(notHead.deps)).toBe(1);
    expect(notHead.err.join('\n')).toMatch(/not HEAD/);
    expect(notHead.vitest).not.toHaveBeenCalled();
    const dirty = harness({ git: baseGit({ 'status --porcelain --untracked-files=no': ' M src/a.ts' }) });
    expect(runGuard(dirty.deps)).toBe(1);
    expect(dirty.err.join('\n')).toMatch(/uncommitted/);
  });
  it('says loudly how many deleted files are not covered', () => {
    const h = harness({ git: baseGit({ [DIFF(B, A)]: nul('D', 'src/gone.ts') }) });
    expect(runGuard(h.deps)).toBe(0);
    expect(h.err.join('\n')).toMatch(/1 deleted source file\(s\) not covered/);
  });
  it('skips with a message when nothing relevant changed', () => {
    const h = harness({ git: baseGit({ [DIFF(B, A)]: nul('M', 'README.md') }) });
    expect(runGuard(h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/SKIPPED/);
    expect(h.vitest).not.toHaveBeenCalled();
  });
  it('a manual file list never checks the working tree', () => {
    const h = harness({ argv: ['src/export/copy.ts'], git: gitOf({ 'rev-parse HEAD': B }) });
    expect(runGuard(h.deps)).toBe(0);
  });
});
