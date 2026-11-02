import type { HeldBack, ImportReport } from '@inspectorhub/offline-package';
import { describe, expect, it } from 'vitest';
import type { ImportOutcome, StopProblem } from '../../offline/import-package';
import { bannedWordsIn, buildResult, mainTextOf } from './result-model';

const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `insp-${String(from + i)}`);
const held = (reason: HeldBack['reason'], count: number, from = 100): HeldBack[] => ids(count, from).map((id) => ({ id, reason }));

function outcome(spec: { imported?: number; held: HeldBack[]; stopped: StopProblem | null; requested?: string[] }): ImportOutcome {
  const report: ImportReport = { imported: ids(spec.imported ?? 0), heldBack: spec.held, skipped: 0, applied: 0, needsAttention: [], requests: 1 };
  return { report, stopped: spec.stopped, requested: new Set(spec.requested ?? []) };
}

const withSignIn = (o: ImportOutcome) => buildResult(o, new Map(), true);
const SIGNED_OUT_ACTION = 'Nothing was uploaded for them. Sign in again, then open Import package and choose the file again. Anything already imported is skipped.';

describe('when the sign-in ended the import and the host can send the person to sign in', () => {
  const signedOut = outcome({ held: held('gave_up', 3), stopped: 'auth' });

  it('the main action is "Sign in again", in place of "Try again", and the others stay secondary', () => {
    const model = withSignIn(signedOut);
    expect(model.headline).toBe('Nothing was imported.');
    expect(model.primary).toEqual({ kind: 'signin', label: 'Sign in again', ids: [] });
    expect(model.secondary.map((s) => s.label)).toEqual(['Import another file', 'Done']);
  });

  it('the sentence says what really happens: the file has to be chosen again, and what was imported is skipped', () => {
    const group = withSignIn(signedOut).groups[0];
    expect(group?.key).toBe('not_sent:auth');
    expect(group?.heading).toBe('These were not sent because you were signed out.');
    expect(group?.action).toBe(SIGNED_OUT_ACTION);
    expect(group?.action).not.toContain('Try again');
  });

  it('some imported, then signed out: the safe and not-safe lines are still there', () => {
    const model = withSignIn(outcome({ imported: 2, held: held('gave_up', 2), stopped: 'auth' }));
    expect(model.headline).toBe('2 of 4 inspections were imported. 2 were not.');
    expect(model.meaning).toContain('Safe: 2 inspections are on the server now.');
    expect(model.meaning).toContain('2 are not on the server.');
    expect(model.meaning).toContain('Your file and the inspections on this device were not changed.');
    expect(model.primary.kind).toBe('signin');
  });

  it('a request that lost its answer first is still "may or may not", and still says to choose the file again after signing in', () => {
    const rows = held('gave_up', 2);
    const model = withSignIn(outcome({ held: rows, stopped: 'auth', requested: rows.map((r) => r.id) }));
    const group = model.groups[0];
    expect(group?.key).toBe('cut_short');
    expect(group?.action).toContain('It may or may not have received them.');
    expect(group?.action).toContain('Sign in again first, then open Import package and choose the file again.');
    expect(group?.action).not.toMatch(/Nothing was uploaded|Try again/);
    expect(model.meaning).toContain('2 may or may not be on the server.');
    expect(model.primary.kind).toBe('signin');
  });

  it('the sign-in comes before saving or retrying, even beside inspections the server said no to', () => {
    const model = withSignIn(outcome({ held: [...held('gave_up', 1), ...held('not_found', 1, 200)], stopped: 'auth' }));
    expect(model.primary.kind).toBe('signin');
    expect(model.groups.map((g) => g.key)).toEqual(['not_sent:auth', 'not_found']);
  });
});

describe('without a way to sign in the page is as it was', () => {
  it('"Try again" and the old sentence', () => {
    const model = buildResult(outcome({ held: held('gave_up', 3), stopped: 'auth' }));
    expect(model.primary).toEqual({ kind: 'retry', label: 'Try again', ids: [] });
    expect(model.groups[0]?.action).toBe('Nothing was uploaded for them. Sign in again, then choose Try again.');
  });

  it('the default is no sign-in button', () => {
    expect(buildResult(outcome({ held: held('gave_up', 1), stopped: 'auth' }), new Map()).primary.kind).toBe('retry');
  });
});

describe('the other reasons sending could not go on have no sign-in cure', () => {
  it.each([
    ['locked', 'retry'],
    ['upgrade', 'done'],
    ['server_too_old', 'done'],
  ] as const)('%s: even when the host can sign in, the main action is not "Sign in again"', (stopped, kind) => {
    const model = withSignIn(outcome({ held: held('gave_up', 2), stopped }));
    expect(model.primary.kind).toBe(kind);
    expect(model.primary.label).not.toBe('Sign in again');
    expect(mainTextOf(model)).not.toContain('Sign in again');
  });

  it('a rejected session (the server said no to the account) keeps "Try again": signing in again is not what unmounts it', () => {
    const model = withSignIn(outcome({ held: [{ id: 'insp-0', reason: 'package_rejected', status: 403 }], stopped: null }));
    expect(model.primary.kind).toBe('retry');
  });

  it('no stop at all: nothing about signing in', () => {
    const model = withSignIn(outcome({ imported: 2, held: [], stopped: null }));
    expect(model.primary.kind).toBe('done');
  });
});

describe('plain words with the sign-in button', () => {
  it.each([
    ['not sent', outcome({ held: held('gave_up', 3), stopped: 'auth' })],
    ['some imported', outcome({ imported: 2, held: held('gave_up', 2), stopped: 'auth' })],
    ['lost its answer first', outcome({ held: held('gave_up', 2), stopped: 'auth', requested: ids(2, 100) })],
    ['mixed', outcome({ held: [...held('gave_up', 1), ...held('deleted', 1, 200)], stopped: 'auth' })],
  ])('%s uses none of the jargon words and no exclamation mark', (_name, o) => {
    const main = mainTextOf(withSignIn(o));
    expect(bannedWordsIn(main)).toEqual([]);
    expect(main).not.toContain('!');
  });

  it('the name of the Settings button may be quoted, but the word "package" on its own is still caught', () => {
    expect(bannedWordsIn('Open Import package and choose the file again.')).toEqual([]);
    expect(bannedWordsIn('Open Import package. The package was not sent.')).toEqual(['package']);
    expect(bannedWordsIn('a package')).toEqual(['package']);
  });

  it('there is exactly one primary action', () => {
    const model = withSignIn(outcome({ held: held('gave_up', 3), stopped: 'auth' }));
    expect([model.primary.label, ...model.secondary.map((s) => s.label)].filter((l) => l === 'Sign in again')).toHaveLength(1);
  });
});
