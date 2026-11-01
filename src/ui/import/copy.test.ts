import { describe, expect, it } from 'vitest';
import { answerText, PROGRESS_NOTE, progressCounts } from './copy';

describe('the answer shown in the details', () => {
  it('names the status and code of the answer, or says there was none', () => {
    expect(answerText({ status: 404, code: 'NOT_FOUND' })).toBe('404 NOT_FOUND');
    expect(answerText({ status: 409 })).toBe('409');
    expect(answerText({})).toBeNull();
  });

  it('never carries a text-direction control from the server', () => {
    expect(answerText({ status: 404, code: `NOT${String.fromCharCode(0x202e)}FOUND` })).toBe('404 NOTFOUND');
  });
});

describe('the progress words', () => {
  it('say what is safe in plain words', () => {
    expect(PROGRESS_NOTE).toMatch(/Closing the app is safe/);
    expect(PROGRESS_NOTE).toMatch(/importing it again is safe/);
    expect(progressCounts(3, 1)).toBe('3 imported so far, 1 not imported');
  });
});
