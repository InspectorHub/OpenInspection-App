import { PACKAGE_MAX_AGE_DAYS, type HeldBack, type ImportReport, type NeedsAttention } from '@inspectorhub/offline-package';
import { describe, expect, it } from 'vitest';
import type { ImportOutcome, StopProblem } from '../../offline/import-package';
import { BANNED_WORDS, bannedWordsIn, buildResult, mainTextOf } from './result-model';

interface Spec {
  imported?: number;
  held?: HeldBack[];
  skipped?: number;
  applied?: number;
  needsAttention?: NeedsAttention[];
  stopped?: StopProblem | null;
  requested?: string[];
  requests?: number;
}

const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `insp-${String(from + i)}`);
const held = (reason: HeldBack['reason'], count: number, extra: Partial<HeldBack> = {}, from = 100): HeldBack[] => ids(count, from).map((id) => ({ id, reason, ...extra }));
const change = (n: number): NeedsAttention => ({ idempotencyKey: `k${String(n)}`, op: 'inspection.update', inspectionId: 'insp-0', status: 422 });

function outcome(spec: Spec): ImportOutcome {
  const report: ImportReport = {
    imported: ids(spec.imported ?? 0),
    heldBack: spec.held ?? [],
    skipped: spec.skipped ?? 0,
    applied: spec.applied ?? 0,
    needsAttention: spec.needsAttention ?? [],
    requests: spec.requests ?? 1,
  };
  return { report, stopped: spec.stopped ?? null, requested: new Set(spec.requested ?? []) };
}

describe('the headline: one plain sentence', () => {
  it.each([
    ['everything imported', { imported: 6 }, 'All 6 inspections were imported.'],
    ['a single inspection', { imported: 1 }, 'The inspection was imported.'],
    ['some imported, some not', { imported: 4, held: held('not_found', 2) }, '4 of 6 inspections were imported. 2 were not.'],
    ['only one was not', { imported: 5, held: held('not_found', 1) }, '5 of 6 inspections were imported. 1 was not.'],
    ['only one was imported', { imported: 1, held: held('not_found', 5) }, '1 of 6 inspections was imported. 5 were not.'],
    ['nothing imported', { held: held('deleted', 3) }, 'Nothing was imported.'],
    ['everything already on the server', { imported: 3, skipped: 4 }, 'All 3 inspections were already imported. Nothing changed.'],
    ['an empty file', {}, 'This file has no inspections, so there was nothing to import.'],
    ['all imported but a change was not applied', { imported: 3, needsAttention: [change(1)] }, 'All 3 inspections were imported. 1 change was not applied.'],
    ['two changes not applied', { imported: 2, needsAttention: [change(1), change(2)] }, 'All 2 inspections were imported. 2 changes were not applied.'],
  ] as Array<[string, Spec, string]>)('%s', (_name, spec, headline) => {
    expect(buildResult(outcome(spec)).headline).toBe(headline);
  });
});

describe('what it means for the data', () => {
  it('says what is safe, what is not on the server, and that nothing on the device changed', () => {
    const lines = buildResult(outcome({ imported: 4, held: held('not_found', 2) })).meaning;
    expect(lines).toContain('Safe: 4 inspections are on the server now.');
    expect(lines).toContain('2 are not on the server.');
    expect(lines).toContain('Your file and the inspections on this device were not changed.');
  });

  it('uses the singular for one', () => {
    const lines = buildResult(outcome({ imported: 1, held: held('not_found', 1) })).meaning;
    expect(lines).toContain('Safe: 1 inspection is on the server now.');
    expect(lines).toContain('1 is not on the server.');
  });

  it('inspections whose request went out without an answer "may or may not" be on the server, never "are not"', () => {
    const rows = held('gave_up', 2);
    const lines = buildResult(outcome({ held: rows, requested: rows.map((r) => r.id) })).meaning;
    expect(lines).toContain('2 may or may not be on the server.');
    expect(lines.join(' ')).not.toMatch(/are not on the server/);
  });

  it('a clean import only asks the person to delete the file when done', () => {
    expect(buildResult(outcome({ imported: 3 })).meaning).toEqual(['Your file was not changed. Delete it when you no longer need it.']);
  });
});

describe('exactly one primary action per situation', () => {
  it.each([
    ['all imported', { imported: 3 } as Spec, { kind: 'done', label: 'Done' }],
    ['the server said no to some', { imported: 4, held: held('not_found', 2) } as Spec, { kind: 'save', label: 'Save the 2 that were not imported' }],
    ['the server said no to one', { imported: 4, held: held('not_found', 1) } as Spec, { kind: 'save', label: 'Save the 1 that was not imported' }],
    ['signed out', { held: held('gave_up', 3), stopped: 'auth' } as Spec, { kind: 'retry', label: 'Try again' }],
    ['locked', { held: held('gave_up', 3), stopped: 'locked' } as Spec, { kind: 'retry', label: 'Try again' }],
    ['the app is too old', { held: held('gave_up', 3), stopped: 'upgrade' } as Spec, { kind: 'done', label: 'Done' }],
    ['the server is too old', { held: held('gave_up', 3), stopped: 'server_too_old' } as Spec, { kind: 'done', label: 'Done' }],
    ['no answer in time', { held: held('gave_up', 2), requested: ids(2, 100) } as Spec, { kind: 'retry', label: 'Try again' }],
    ['a mix: trying again wins over saving', { held: [...held('gave_up', 1), ...held('not_found', 1, {}, 200)], requested: ['insp-100'] } as Spec, { kind: 'retry', label: 'Try again' }],
    ['the file is too old', { held: held('package_rejected', 2, { status: 422, code: 'PACKAGE_EXPIRED' }) } as Spec, { kind: 'done', label: 'Done' }],
  ])('%s', (_name, spec, expected) => {
    expect(buildResult(outcome(spec)).primary).toMatchObject(expected);
  });

  it('the save action carries exactly the inspections that can be saved', () => {
    expect(buildResult(outcome({ imported: 1, held: held('not_found', 2) })).primary.ids).toEqual(['insp-100', 'insp-101']);
  });
});

describe('the inspections that were not imported, grouped by what happened', () => {
  const group = (spec: Spec, key: string) => buildResult(outcome(spec)).groups.find((g) => g.key === key);

  it('never sent because of the sign-in: nothing was uploaded for them, and what to do', () => {
    const g = buildResult(outcome({ held: held('gave_up', 3), stopped: 'auth' })).groups;
    expect(g).toHaveLength(1);
    expect(g[0]?.heading).toBe('These were not sent because you were signed out.');
    expect(g[0]?.action).toBe('Nothing was uploaded for them. Sign in again, then choose Try again.');
    expect(g[0]?.rows).toHaveLength(3);
  });

  it('never sent because the device is locked', () => {
    expect(group({ held: held('gave_up', 1), stopped: 'locked' }, 'not_sent:locked')).toMatchObject({
      heading: 'This inspection was not sent because this device is locked.',
      action: 'Nothing was uploaded for it. Verify this device online, then choose Try again.',
    });
  });

  it('sent without an answer and then cut short by the sign-in: may have arrived, so it does NOT say nothing was uploaded', () => {
    const rows = held('gave_up', 2);
    const g = group({ held: rows, stopped: 'auth', requested: rows.map((r) => r.id) }, 'cut_short');
    expect(g?.heading).toBe('Sending was cut short before the server replied for these.');
    expect(g?.action).toContain('It may or may not have received them.');
    expect(g?.action).toContain('Trying again is safe');
    expect(g?.action).toContain('Sign in again first.');
    expect(g?.action).not.toMatch(/Nothing was uploaded/);
  });

  it('plain no-answer, singular', () => {
    const rows = held('gave_up', 1);
    expect(group({ held: rows, requested: [rows[0]?.id ?? ''] }, 'no_answer')?.heading).toBe('The server did not answer in time for this inspection.');
  });

  it('a failure on this device and a busy server are told apart', () => {
    const local = held('gave_up', 1, { detail: 'local_error' });
    expect(group({ held: local, requested: ['insp-100'] }, 'local')?.heading).toBe('Something went wrong on this device before the server could answer for this inspection.');
    const busy = held('gave_up', 2, { status: 503 });
    expect(group({ held: busy, requested: ['insp-100', 'insp-101'] }, 'busy')?.heading).toBe('The server was busy or not available for these.');
  });

  it.each([
    ['not_found', 'The server could not find them in your company.'],
    ['forbidden', 'Your account is not allowed to change these.'],
    ['different_report', 'The report in the file is not the report these have now.'],
    ['deleted', 'These were deleted after the file was made.'],
    ['apply_failed', 'The server could not save the data or a change for these.'],
    ['refused', 'The server said no to these for a reason this app does not know.'],
    ['too_large_to_split', 'These are each too big to send in one go.'],
  ] as Array<[HeldBack['reason'], string]>)('the server said no: %s', (reason, heading) => {
    const g = buildResult(outcome({ held: held(reason, 2) })).groups[0];
    expect(g?.heading).toBe(heading);
    expect(g?.save).toBe(true);
    expect(g?.action.length).toBeGreaterThan(20);
  });

  it('inspections whose report was published after the file was made are one group of their own, with what to do and nothing said about an unknown reason', () => {
    const two = buildResult(outcome({ held: held('refused', 2, { status: 409, code: 'REPORT_PUBLISHED' }) })).groups;
    expect(two).toHaveLength(1);
    expect(two[0]?.key).toBe('published');
    expect(two[0]?.heading).toBe('These reports were published after the file was made.');
    expect(two[0]?.action).toContain('Edit and republish');
    expect(two[0]?.action).toContain('still in your file');
    expect(two[0]?.save).toBe(true);
    expect(bannedWordsIn(`${two[0]?.heading ?? ''} ${two[0]?.action ?? ''}`)).toEqual([]);
    const one = buildResult(outcome({ held: held('refused', 1, { status: 409, code: 'REPORT_PUBLISHED' }) })).groups[0];
    expect(one?.heading).toBe('This report was published after the file was made.');
    expect(one?.action).toContain('it is still in your file');
  });

  it('control: a refusal with another code, or with none, still reads as a reason this app does not know, and the two groups stay apart', () => {
    const mixed = buildResult(outcome({ held: [...held('refused', 1, { status: 409, code: 'REPORT_PUBLISHED' }, 100), ...held('refused', 1, { status: 409, code: 'SOMETHING_ELSE' }, 200)] })).groups;
    expect(mixed.map((g) => g.key).sort()).toEqual(['published', 'refused']);
    expect(buildResult(outcome({ held: held('refused', 1) })).groups[0]?.key).toBe('refused');
  });

  it('a whole file that is too old says the number of days the SERVER named, and a fallback only when it named none', () => {
    const named = buildResult(outcome({ held: held('package_rejected', 2, { status: 422, code: 'PACKAGE_EXPIRED', details: { maxAgeDays: 30 } }) })).groups[0];
    expect(named?.heading).toBe('This file is more than 30 days old, so it cannot be imported.');
    expect(named?.heading).not.toContain(String(PACKAGE_MAX_AGE_DAYS));
    const silent = buildResult(outcome({ held: held('package_rejected', 2, { status: 422, code: 'PACKAGE_EXPIRED' }) })).groups[0];
    expect(silent?.heading).toContain(`${String(PACKAGE_MAX_AGE_DAYS)} days`);
  });

  it('a file dated ahead: 1 day is singular, and the figure is the server one', () => {
    const one = buildResult(outcome({ held: held('package_rejected', 1, { code: 'PACKAGE_FROM_THE_FUTURE', details: { maxFutureSkewDays: 1 } }) })).groups[0];
    expect(one?.heading).toBe("This file is dated more than 1 day ahead of the server's clock, so the server said no.");
    const three = buildResult(outcome({ held: held('package_rejected', 1, { code: 'PACKAGE_FROM_THE_FUTURE', details: { maxFutureSkewDays: 3 } }) })).groups[0];
    expect(three?.heading).toContain('3 days ahead');
  });

  it('the sign-in or account permission is told apart from the whole file being turned down', () => {
    expect(buildResult(outcome({ held: held('package_rejected', 1, { status: 403 }) })).groups[0]?.heading).toBe('Your account may not be allowed to import, or you were signed out.');
    expect(buildResult(outcome({ held: held('package_rejected', 1, { status: 400 }) })).groups[0]?.heading).toBe('The server said no to the whole file.');
  });

  it('inspections with the same reason share one group, in the order they first appear', () => {
    const mixed = [...held('not_found', 1, {}, 100), ...held('deleted', 1, {}, 200), ...held('not_found', 1, {}, 300)];
    const groups = buildResult(outcome({ held: mixed })).groups;
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([['insp-100', 'insp-300'], ['insp-200']]);
  });
});

describe('technical details stay out of the main text', () => {
  const rows: HeldBack[] = [{ id: 'insp-1', reason: 'not_found', status: 404, code: `NOT_${String.fromCharCode(0x202e)}FOUND`, detail: 'idempotency_in_flight' }];
  const spec: Spec = { imported: 2, held: rows, skipped: 3, applied: 1, requests: 4, needsAttention: [{ idempotencyKey: 'k1', op: 'inspection.update', inspectionId: 'insp-0', status: 422, reason: 'invalid' }] };

  it('the answer code, status, counts and internal reasons are in the details, sanitised', () => {
    const details = buildResult(outcome(spec)).details.join('\n');
    expect(details).toContain('Requests sent: 4');
    expect(details).toContain('insp-1: not_found. Server answer: 404 NOT_FOUND. Server detail: idempotency_in_flight');
    expect(details).toContain('inspection.update on inspection insp-0: server answer 422, reason invalid');
    expect(details).toContain('Imported: 2. Already on the server: 3. Applied: 1.');
    expect(details).not.toContain(String.fromCharCode(0x202e));
  });

  it('none of it is in the main text', () => {
    const main = mainTextOf(buildResult(outcome(spec)));
    for (const technical of ['404', 'NOT_FOUND', 'not_found', 'idempotency', 'Requests sent', 'inspection.update', '422', 'Server answer']) expect(main).not.toContain(technical);
  });
});

describe('plain words only', () => {
  const situations: Array<[string, Spec]> = [
    ['all imported', { imported: 6 }],
    ['partial', { imported: 4, held: held('not_found', 2) }],
    ['nothing', { held: held('deleted', 3) }],
    ['signed out', { held: held('gave_up', 3), stopped: 'auth' }],
    ['locked', { held: held('gave_up', 3), stopped: 'locked' }],
    ['app too old', { held: held('gave_up', 3), stopped: 'upgrade' }],
    ['server too old', { held: held('gave_up', 3), stopped: 'server_too_old' }],
    ['timeout then sign-out', { held: held('gave_up', 2), stopped: 'auth', requested: ids(2, 100) }],
    ['no answer', { held: held('gave_up', 2), requested: ids(2, 100) }],
    ['busy', { held: held('gave_up', 2, { status: 503 }), requested: ids(2, 100) }],
    ['local', { held: held('gave_up', 2, { detail: 'local_error' }), requested: ids(2, 100) }],
    ['expired', { held: held('package_rejected', 2, { status: 422, code: 'PACKAGE_EXPIRED', details: { maxAgeDays: 30 } }) }],
    ['future', { held: held('package_rejected', 2, { code: 'PACKAGE_FROM_THE_FUTURE' }) }],
    ['session', { held: held('package_rejected', 2, { status: 403 }) }],
    ['whole file turned down', { held: held('package_rejected', 2, { status: 400 }) }],
    ...(['not_found', 'forbidden', 'different_report', 'deleted', 'apply_failed', 'refused', 'too_large_to_split'] as const).map((r): [string, Spec] => [r, { imported: 1, held: held(r, 2) }]),
    ['all skipped', { imported: 3, skipped: 2 }],
    ['changes not applied', { imported: 3, needsAttention: [change(1)] }],
    ['empty', {}],
  ];

  it.each(situations)('%s uses none of the jargon words and no exclamation mark', (_name, spec) => {
    const main = mainTextOf(buildResult(outcome(spec)));
    expect(bannedWordsIn(main)).toEqual([]);
    expect(main).not.toContain('!');
  });

  it('control: the check can fail. It finds every banned word, in any case, and nothing in plain text', () => {
    for (const word of BANNED_WORDS) expect(bannedWordsIn(`Some of them were ${word.toUpperCase()} today`)).toContain(word);
    expect(bannedWordsIn('2 inspections were not imported. Try again.')).toEqual([]);
    expect(BANNED_WORDS).toEqual(expect.arrayContaining(['held back', 'gave up', 'refused', 'unsent', 'unconfirmed', 'stopped', 'not confirmed', 'part', 'package']));
  });

  it('control: a banned word hidden in a group heading would be caught', () => {
    const model = buildResult(outcome({ imported: 1, held: held('not_found', 1) }));
    const tampered = { ...model, groups: model.groups.map((g) => ({ ...g, heading: `${g.heading} held back` })) };
    expect(bannedWordsIn(mainTextOf(tampered))).toEqual(['held back']);
  });
});
