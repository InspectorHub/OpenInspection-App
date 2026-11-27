import { describe, expect, it } from 'vitest';
import { downloadEtaMs, downloadProgressText, failedDownloadLines } from './copy';

describe('downloadEtaMs', () => {
  it('is null until two are done: one sample is not a pace', () => {
    expect(downloadEtaMs(0, 0, 4, 10_000)).toBeNull();
    expect(downloadEtaMs(0, 1, 4, 10_000)).toBeNull();
  });

  it('is null when nothing is left or no time passed', () => {
    expect(downloadEtaMs(0, 4, 4, 10_000)).toBeNull();
    expect(downloadEtaMs(10_000, 2, 4, 10_000)).toBeNull();
  });

  it('is null for a remainder under five seconds', () => {
    expect(downloadEtaMs(0, 9, 10, 9000)).toBeNull();
  });

  it('scales the elapsed time by what is left', () => {
    expect(downloadEtaMs(0, 2, 4, 20_000)).toBe(20_000);
    expect(downloadEtaMs(1000, 1, 2, 1000)).toBeNull();
    expect(downloadEtaMs(0, 3, 6, 30_000)).toBe(30_000);
  });
});

describe('downloadProgressText', () => {
  it('says only Downloading… while the list is still being read', () => {
    expect(downloadProgressText({ done: 0, total: 0 }, null)).toBe('Downloading…');
  });

  it('counts done of total, and adds the ETA once there is one', () => {
    expect(downloadProgressText({ done: 3, total: 12 }, null)).toBe('Downloading… 3 of 12');
    expect(downloadProgressText({ done: 3, total: 12 }, 20_000)).toBe('Downloading… 3 of 12 · about 20 seconds left');
    expect(downloadProgressText({ done: 3, total: 12 }, 90_000)).toBe('Downloading… 3 of 12 · about 2 minutes left');
    expect(downloadProgressText({ done: 3, total: 12 }, 60_000)).toBe('Downloading… 3 of 12 · about 1 minute left');
  });
});

describe('failedDownloadLines', () => {
  it('lists every name when there are few', () => {
    expect(failedDownloadLines(['12 Oak Street', '7 Mill Lane'], 2)).toEqual(['12 Oak Street', '7 Mill Lane']);
  });

  it('shows at most five names, then the rest as a count', () => {
    expect(failedDownloadLines(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 7)).toEqual(['a', 'b', 'c', 'd', 'e', 'and 2 more']);
  });

  it('counts names the list could not show as more', () => {
    expect(failedDownloadLines(['12 Oak Street'], 3)).toEqual(['12 Oak Street', 'and 2 more']);
  });

  it('is empty when nothing failed', () => {
    expect(failedDownloadLines([], 0)).toEqual([]);
  });
});
