// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { realTimers } from '../../collab/timers';
import type { ReconcileOutcome } from '../../offline/reconciler';
import { LiveNote } from './LiveNote';
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
  it('the download summary: empty keeps one blank line of height (so the list does not jump when a summary arrives), and stays a polite live region', () => {
    header(null);
    const region = screen.getByTestId('refresh-summary');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.textContent).toBe('');
    expect(region.className).toMatch(/min-h-6/);
    expect(region.className).not.toContain('sr-only');
  });

  it('the download summary: with text it is an ordinary visible line, in the same element so the announcement is made', () => {
    const { rerender } = header(null);
    const region = screen.getByTestId('refresh-summary');
    rerender(<WorkListHeader updatedAt={1000} now={2000} locale="en-US" chip={null} downloading={false} summary="Updated 1 inspection." onDownload={() => undefined} headingRef={() => undefined} />);
    expect(screen.getByTestId('refresh-summary')).toBe(region);
    expect(region).toHaveTextContent('Updated 1 inspection.');
    expect(region.className).not.toContain('sr-only');
    expect(region.className).toMatch(/min-h-6/);
  });

  it('while downloading it is announced but not shown: the activity bar in the button shows the state, and the reserved line stays the same height', () => {
    header(null, true);
    const region = screen.getByTestId('refresh-summary');
    expect(region).toHaveTextContent('Downloading…');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.className).toMatch(/min-h-6/);
    expect(region.querySelector('span.sr-only')).toHaveTextContent('Downloading…');
  });

  it('control: a note without the reservation (the server-check note) still takes no room while empty', () => {
    const { container } = render(<LiveNote className="text-sm" text="" />);
    expect(container.querySelector('p')?.className).toContain('sr-only');
    expect(container.querySelector('p')?.className).not.toMatch(/min-h-/);
  });

  it('the server-check note: empty is out of the flow and has no reserved height', () => {
    render(<ReconcileStatus outcome={OUTCOME} now={2000} locale="en-US" onCheck={() => undefined} canRun timers={realTimers} onReview={null} />);
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.className).toContain('sr-only');
    expect(region?.className ?? '').not.toMatch(/min-h-/);
  });
});
