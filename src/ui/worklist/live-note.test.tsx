// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { realTimers } from '../../collab/timers';
import type { ReconcileOutcome } from '../../offline/reconciler';
import { ReconcileStatus } from './ReconcileStatus';
import { WorkListHeader } from './WorkListHeader';

afterEach(cleanup);

const OUTCOME: ReconcileOutcome = {
  status: 'done',
  reason: null,
  at: 1000,
  massSuspicious: false,
  allMissing: false,
  candidateCount: 3,
  unavailableRole: false,
  refusedNullInspectionId: false,
  counts: null,
  resumed: 0,
  resumeFailed: false,
};

function header(summary: string | null, downloading = false) {
  return render(<WorkListHeader updatedAt={1000} now={2000} locale="en-US" chip={null} downloading={downloading} summary={summary} onDownload={() => undefined} headingRef={() => undefined} />);
}

describe('an empty live region takes no room in the layout', () => {
  it('the download summary: empty means out of the flow (screen-reader only) with no reserved height, and it stays a polite live region', () => {
    header(null);
    const region = screen.getByTestId('refresh-summary');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.textContent).toBe('');
    expect(region.className).toContain('sr-only');
    expect(region.className).not.toMatch(/min-h-/);
  });

  it('the download summary: with text it is an ordinary visible line, in the same element so the announcement is made', () => {
    const { rerender } = header(null);
    const region = screen.getByTestId('refresh-summary');
    rerender(<WorkListHeader updatedAt={1000} now={2000} locale="en-US" chip={null} downloading={false} summary="Updated 1 inspection." onDownload={() => undefined} headingRef={() => undefined} />);
    expect(screen.getByTestId('refresh-summary')).toBe(region);
    expect(region).toHaveTextContent('Updated 1 inspection.');
    expect(region.className).not.toContain('sr-only');
    expect(region.className).not.toMatch(/min-h-/);
  });

  it('while downloading it shows its line', () => {
    header(null, true);
    expect(screen.getByTestId('refresh-summary')).toHaveTextContent('Downloading…');
    expect(screen.getByTestId('refresh-summary').className).not.toContain('sr-only');
  });

  it('the server-check note: empty is out of the flow and has no reserved height', () => {
    render(<ReconcileStatus outcome={OUTCOME} now={2000} locale="en-US" onCheck={() => undefined} canRun timers={realTimers} onReview={null} />);
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.className).toContain('sr-only');
    expect(region?.className ?? '').not.toMatch(/min-h-/);
  });
});
