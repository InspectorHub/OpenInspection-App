import { describe, expect, it } from 'vitest';
import { failureText, NOTHING_TO_EXPORT, summaryText } from './copy';
import type { ExportDone } from './exporter';

function done(patch: Partial<ExportDone> = {}): ExportDone {
  return { kind: 'shared', inspections: 2, photos: 3, writes: 1, photosMissing: 0, changedSincePrepare: 0, unconfirmed: false, leftover: false, kept: false, omitted: { creationRefused: 0, failedWrites: 0, reportIdUnknown: 0, videos: 0, photoEdits: 0, skippedWrites: 0, alreadyOnServer: 0 }, ...patch } as ExportDone;
}

describe('export wording per platform', () => {
  it('pins the current share-sheet strings for Android and iOS', () => {
    expect(summaryText(done({ kept: true }), 'android')).toBe('Export handed to the share sheet: 2 inspections, 3 photos, 1 change waiting to upload. The temporary file will be deleted within 10 minutes.');
    expect(summaryText(done({ kept: true, kind: 'cancelled' }), 'android')).toBe('Sharing was cancelled or did not finish. It held 2 inspections, 3 photos, 1 change waiting to upload. The temporary file will be deleted within 10 minutes.');
    expect(summaryText(done(), 'ios')).toBe('Export handed to the share sheet: 2 inspections, 3 photos, 1 change waiting to upload. The temporary file was deleted from this device.');
    expect(failureText('share_failed', 'android')).toBe('The share sheet could not be opened. Nothing on this device was changed. Try again.');
    expect(failureText('build_failed', 'android')).toBe('The export file could not be prepared. Nothing on this device was changed. Try again.');
  });

  it('never mentions a share sheet on Windows and says the temporary file was deleted after saving', () => {
    const saved = summaryText(done(), 'windows');
    const cancelled = summaryText(done({ kind: 'cancelled' }), 'windows');
    for (const text of [saved, cancelled, failureText('share_failed', 'windows')]) expect(text).not.toMatch(/share|sharing/i);
    expect(saved).toContain('2 inspections, 3 photos, 1 change waiting to upload');
    expect(saved).toContain('The temporary file was deleted from this device after saving.');
    expect(cancelled).toContain('Saving was cancelled or did not finish.');
  });

  it('does not claim a deletion that did not happen', () => {
    expect(summaryText(done({ leftover: true }), 'windows')).not.toMatch(/was deleted/);
  });

  it('uses one sentence for nothing to export', () => {
    expect(NOTHING_TO_EXPORT).toBe('There is nothing to export.');
  });
});
