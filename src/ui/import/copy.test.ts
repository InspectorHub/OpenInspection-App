import { PACKAGE_MAX_AGE_DAYS, type HeldBack, type HeldBackReason } from '@inspectorhub/offline-package';
import { describe, expect, it } from 'vitest';
import { answerText, explainHeldBack, groupHeldBack, STOP_TEXT } from './copy';

const REASONS: HeldBackReason[] = ['not_found', 'forbidden', 'different_report', 'deleted', 'apply_failed', 'refused', 'too_large_to_split', 'package_rejected', 'gave_up'];

describe('held-back explanations', () => {
  it('every reason the shared import can report has its own label, sentence and next step', () => {
    const seen = new Set<string>();
    const labels = new Set<string>();
    for (const reason of REASONS) {
      const e = explainHeldBack({ id: 'i', reason });
      expect(e.label.length).toBeGreaterThan(2);
      expect(e.what.length).toBeGreaterThan(10);
      expect(e.next.length).toBeGreaterThan(10);
      seen.add(e.what);
      labels.add(e.label);
    }
    expect(seen.size).toBe(REASONS.length);
    expect(labels.size).toBe(REASONS.length);
  });

  it('an expired package says the number of days the SERVER named, not a built-in one', () => {
    const e = explainHeldBack({ id: 'i', reason: 'package_rejected', status: 422, code: 'PACKAGE_EXPIRED', details: { maxAgeDays: 30 } });
    expect(e.what).toContain('30 days');
    expect(e.what).not.toContain(String(PACKAGE_MAX_AGE_DAYS));
    expect(e.group).toBe('package_rejected:expired');
  });

  it('control: when the server named no figure, the shared package constant is used', () => {
    const e = explainHeldBack({ id: 'i', reason: 'package_rejected', status: 422, code: 'PACKAGE_EXPIRED' });
    expect(e.what).toContain(`${String(PACKAGE_MAX_AGE_DAYS)} days`);
  });

  it('a package dated ahead says the server figure, and 1 is singular', () => {
    const many = explainHeldBack({ id: 'i', reason: 'package_rejected', code: 'PACKAGE_FROM_THE_FUTURE', details: { maxFutureSkewDays: 3 } });
    expect(many.what).toContain('3 days ahead');
    const one = explainHeldBack({ id: 'i', reason: 'package_rejected', code: 'PACKAGE_FROM_THE_FUTURE', details: { maxFutureSkewDays: 1 } });
    expect(one.what).toContain('1 day ahead');
    expect(one.what).not.toContain('1 days');
  });

  it('a refused session is told apart from a refused package', () => {
    expect(explainHeldBack({ id: 'i', reason: 'package_rejected', status: 403 }).group).toBe('package_rejected:session');
    expect(explainHeldBack({ id: 'i', reason: 'package_rejected', status: 400 }).group).toBe('package_rejected');
  });

  it('a failure on this device is told apart from the server not answering', () => {
    expect(explainHeldBack({ id: 'i', reason: 'gave_up', detail: 'local_error' }).what).toMatch(/on this device/);
    expect(explainHeldBack({ id: 'i', reason: 'gave_up' }).what).toMatch(/did not confirm/);
  });

  it('rows with one explanation are listed under it once; rows with different ones are not merged', () => {
    const rows: HeldBack[] = [
      { id: 'a', reason: 'gave_up' },
      { id: 'b', reason: 'not_found', status: 404 },
      { id: 'c', reason: 'gave_up' },
    ];
    const groups = groupHeldBack(rows);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([['a', 'c'], ['b']]);
  });

  it('names the status and code of the answer, or says there was none', () => {
    expect(answerText({ status: 404, code: 'NOT_FOUND' })).toBe('404 NOT_FOUND');
    expect(answerText({ status: 409 })).toBe('409');
    expect(answerText({})).toBeNull();
  });

  it('the answer shown for a row never carries a text-direction control from the server', () => {
    expect(answerText({ status: 404, code: `NOT${String.fromCharCode(0x202e)}FOUND` })).toBe('404 NOTFOUND');
    expect(answerText({ status: 404, code: 'NOT_FOUND' })).toBe('404 NOT_FOUND');
  });

  it('each stop reason has its own instruction', () => {
    expect(STOP_TEXT.auth.title).toBe('Sign in again');
    expect(STOP_TEXT.upgrade.title).toBe('Update the app');
    expect(new Set(Object.values(STOP_TEXT).map((t) => t.body)).size).toBe(4);
  });
});
