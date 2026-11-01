import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The visual layout baselines (regression plan T4) are made and compared by one workflow on one runner. This test cannot take a
 * screenshot; it pins the wiring around them, so that the comparison cannot quietly turn into "always regenerate", the sharded CI run
 * cannot start failing for lack of baselines, and a baseline made on another platform cannot be committed under the Windows name.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

interface Step { id?: string; name?: string; uses?: string; if?: string; run?: string; shell?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Workflow { on: { workflow_dispatch?: unknown; pull_request?: { paths?: string[] } }; permissions?: Record<string, string>; jobs: Record<string, { 'runs-on'?: string; 'timeout-minutes'?: number; steps: Step[] }> }

const text = read('.github', 'workflows', 'visual-baselines.yml');
const workflow = parse(text) as Workflow;
const steps = workflow.jobs.visual?.steps ?? [];
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};

describe('the visual-baselines workflow', () => {
  it('runs on windows-latest, by hand and on pull requests that touch what the screens are made of, with read-only permissions and no secret', () => {
    expect(workflow.jobs.visual?.['runs-on']).toBe('windows-2025'); // pinned: a new runner image can change font rendering, which means regenerating every baseline
    expect(workflow.on.workflow_dispatch).toBeDefined();
    const paths = workflow.on.pull_request?.paths ?? [];
    for (const path of ['src/**', 'electron/**', 'e2e-electron/**', '.github/workflows/visual-baselines.yml']) expect(paths, path).toContain(path);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toContain('secrets.');
    for (const s of steps) if (s.uses !== undefined) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}\b/);
    expect(steps.some((s) => s.uses?.startsWith('actions/upload-artifact@'))).toBe(true); // control: the pin check had something to fail on
  });

  it('compares when baselines exist and only then, and only the generating step may update them', () => {
    const decide = step('Are baselines committed?');
    expect(decide.id).toBe('baselines');
    expect(decide.run).toContain('e2e-electron/visual-baselines/*-win32.png');
    const compare = step('Compare against the committed baselines');
    expect(compare.if).toBe("steps.baselines.outputs.present == 'true'");
    expect(compare.run).toBe('npx playwright test -c e2e-electron/playwright.config.ts --project=visual');
    const create = step('Create the baselines (none are committed yet)');
    const generate = "steps.baselines.outputs.present == 'false' && github.event_name == 'workflow_dispatch'";
    expect(create.if).toBe(generate);
    expect(create.run).toBe('npx playwright test -c e2e-electron/playwright.config.ts --project=visual --update-snapshots=all');
    // No other step touches snapshots, and nothing else runs the visual project.
    expect(steps.filter((s) => (s.run ?? '').includes('update-snapshots')).map((s) => s.name)).toEqual([create.name]);
    expect(steps.filter((s) => (s.run ?? '').includes('--project=visual'))).toHaveLength(2);
  });

  it('hands the generated baselines over as an artifact, and keeps the diff images when a comparison fails', () => {
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.name === 'visual-baselines-win32');
    expect(upload?.if).toBe("steps.baselines.outputs.present == 'false' && github.event_name == 'workflow_dispatch'");
    expect(upload?.with?.path).toBe('e2e-electron/visual-baselines');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const diff = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@') && s.with?.name === 'visual-diff-context');
    expect(diff?.if).toBe('failure()');
    // The Playwright output folder is hidden (.superpowers/...), and upload-artifact skips hidden paths unless told not to.
    expect(diff?.with?.['include-hidden-files']).toBe(true);
    expect(read('e2e-electron', 'playwright.config.ts')).toContain(String(diff?.with?.path).replace('.superpowers/', '../.superpowers/').replace(/\/$/, ''));
    expect(String(diff?.with?.path)).toContain('test-results');
    expect(step('Say what to do with the new baselines').run).toContain('::warning::');
    expect(step('Say what to do with the new baselines').if).toBe("steps.baselines.outputs.present == 'false' && github.event_name == 'workflow_dispatch'");
  });

  it('a pull request with no baselines FAILS; only a manual run may generate them', () => {
    const refuse = step('Refuse a pull request that has no committed baselines');
    expect(refuse.if).toBe("steps.baselines.outputs.present == 'false' && github.event_name == 'pull_request'");
    expect(refuse.run).toContain('::error::');
    expect(refuse.run).toContain('exit 1');
    expect(refuse.run).toContain('Run workflow');
  });

  it('builds the Electron main process and installs Chromium before it runs the spec', () => {
    const names = steps.map((s) => s.name ?? s.run ?? '');
    const build = names.indexOf('Build the Electron main process and preload');
    const chromium = names.indexOf('Install the pinned Chromium (for the blocking pages)');
    const compare = names.indexOf('Compare against the committed baselines');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(chromium).toBeGreaterThanOrEqual(0);
    expect(Math.max(build, chromium)).toBeLessThan(compare);
    expect(step('Build the Electron main process and preload').run).toBe('node scripts/build-electron.mjs');
    expect(step('Install the pinned Chromium (for the blocking pages)').run).toBe('npx playwright install chromium');
  });
});

describe('the Playwright config and the spec', () => {
  const config = read('e2e-electron', 'playwright.config.ts');
  const spec = read('e2e-electron', 'layout.visual.spec.ts');

  it('keeps the visual spec out of the sharded ci project and the local project, in a project of its own', () => {
    expect(config).toContain("name: 'ci', testIgnore: ['**/*.local.spec.ts', '**/*.visual.spec.ts']");
    expect(config).toContain("name: 'visual', testMatch: '**/*.visual.spec.ts'");
    expect(config).toContain("name: 'local', testMatch: '**/*.local.spec.ts'");
    // The sharded CI run names the ci project, so it never meets the visual spec.
    expect(read('.github', 'workflows', 'ci.yml')).toContain('--project=ci --shard=');
  });

  it('names each baseline by platform, so a baseline from another platform cannot take the Windows name', () => {
    expect(config).toContain("snapshotPathTemplate: '{testDir}/visual-baselines/{arg}-{platform}{ext}'");
    const dir = join(ROOT, 'e2e-electron', 'visual-baselines');
    if (existsSync(dir)) for (const name of readdirSync(dir)) expect(name, name).toMatch(/-win32\.png$/);
  });

  it('covers the five screens in light and dark, wide and narrow, and says it is a layout check only', () => {
    for (const stem of ["'work-list'", "'settings'", "'export'", "'editor'", 'screen.name']) expect(spec, stem).toContain(stem);
    for (const name of ['blocking-key-unreadable', 'blocking-encryption-unavailable', 'blocking-corrupt', 'blocking-db-key-lost']) expect(spec, name).toContain(name);
    expect(spec).toContain("const THEMES = ['light', 'dark'] as const");
    expect(spec).toMatch(/key: 'wide', width: 1280/);
    expect(spec).toMatch(/key: 'narrow', width: 480/);
    expect(spec).toContain('LAYOUT regression only');
    // Text that changes between runs is frozen before every screenshot, or the comparison would fail on a different day.
    expect(spec).toContain('freezeChangingText');
    // The spec only compares; it never decides to update.
    expect(spec).not.toContain('updateSnapshots');
  });
});
