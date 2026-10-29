import { describe, expect, it } from 'vitest';
import { MESSAGES, blockedResult, isNeedsConnection, needsConnectionResult } from './messages';

describe('field messages', () => {
  it('needs-connection result carries the fixed sentence, never the internal code', () => {
    const result = needsConnectionResult();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MESSAGES.needsConnection);
    expect(result.error).not.toBe('needs_connection');
    expect(result.error).not.toMatch(/_/);
  });

  it('every sentence is a readable English sentence, not a code', () => {
    for (const sentence of Object.values(MESSAGES)) {
      expect(sentence).toMatch(/^[A-Z][^_]*\.$/);
    }
  });

  it('predicate: true only for the needs-connection result', () => {
    expect(isNeedsConnection(needsConnectionResult())).toBe(true);
    expect(isNeedsConnection(blockedResult())).toBe(false);
    expect(isNeedsConnection({ ok: true })).toBe(false);
    expect(isNeedsConnection({ ok: false, error: 'needs_connection' })).toBe(false);
  });

  it('keeps the data a caller attaches next to the sentence', () => {
    const result = needsConnectionResult({ facts: null, reason: 'REQUEST_FAILED' });
    expect(result.data).toEqual({ facts: null, reason: 'REQUEST_FAILED' });
    expect(isNeedsConnection(result)).toBe(true);
  });

  it('the lines that must differ do differ', () => {
    const all = Object.values(MESSAGES);
    expect(new Set(all).size).toBe(all.length);
    expect(MESSAGES.deviceLocked).not.toBe(MESSAGES.sessionExpired);
  });

  // The person reading this has a tag that vanished and no idea why. It has to say what happened, the likely reason, what
  // to do, and who to ask when that is not enough; and it cannot say "this item", because it can appear while another
  // inspection is open.
  it('the notice for refused tag changes says what happened, why, what to do and who to ask', () => {
    const notice = MESSAGES.tagsNotSynced;
    expect(notice).toMatch(/undone/);
    expect(notice).toMatch(/deleted/);
    expect(notice).toMatch(/not be allowed/);
    expect(notice).toMatch(/Open the inspection, check its tags, and choose them again/);
    expect(notice).toMatch(/ask your administrator/);
    expect(notice).not.toMatch(/\bthis (item|inspection)\b/i);
  });

  it('blocked result uses the blocked sentence', () => {
    expect(blockedResult().error).toBe(MESSAGES.blocked);
  });
});
