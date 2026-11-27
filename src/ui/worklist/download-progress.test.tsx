// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkListHeader } from './WorkListHeader';

afterEach(cleanup);

function header(downloading: boolean, summary: string | null = null, progress: { done: number; total: number } | null = null, etaMs: number | null = null, failedLines: string[] = []) {
  return render(
    <WorkListHeader updatedAt={1000} now={2000} locale="en-US" chip={null} downloading={downloading} progress={progress} etaMs={etaMs} failedLines={failedLines} summary={summary} onDownload={() => undefined} headingRef={() => undefined} onSettings={() => undefined} settingsRef={() => undefined} />,
  );
}

/** Text lines that take room in the layout: every paragraph that is not screen-reader only. */
function visibleLines(container: HTMLElement): number {
  return container.querySelectorAll('p:not(.sr-only)').length;
}

describe('downloading today\'s work', () => {
  it('shows the progress inside the button: the button is busy and disabled with the same name (tapping again must still find it), and an activity bar is drawn', () => {
    header(true);
    const button = screen.getByRole('button', { name: "Download today's work" });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    const bar = screen.getByTestId('download-progress');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(button.parentElement).toContainElement(bar);
  });

  it('control: when idle the button is not busy and there is no activity bar', () => {
    header(false);
    expect(screen.getByRole('button', { name: "Download today's work" })).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('download-progress')).toBeNull();
  });

  it('adds no line of text to the layout while downloading (that line pushed the list down and back up: the page shook), and still announces it', () => {
    const idle = header(false);
    const before = visibleLines(idle.container);
    cleanup();
    const busy = header(true);
    expect(visibleLines(busy.container)).toBe(before);
    const note = screen.getByTestId('refresh-summary');
    expect(note).toHaveAttribute('aria-live', 'polite');
    expect(note.textContent).toBe('Downloading…');
    expect(note.querySelector('span.sr-only')).toHaveTextContent('Downloading…');
  });

  it('control: a finished download shows its summary as an ordinary visible line, in the same live region', () => {
    header(false, 'Downloaded 3 inspections.');
    const note = screen.getByTestId('refresh-summary');
    expect(note.textContent).toBe('Downloaded 3 inspections.');
    expect(note.className).not.toContain('sr-only');
  });

  it('the activity bar pulses only for people who allow motion', () => {
    header(true);
    const inner = screen.getByTestId('download-progress').firstElementChild;
    expect(inner?.className).toContain('motion-safe:animate-pulse');
    expect(inner?.className).not.toMatch(/(^|\s)animate-/);
  });

  it('once the list is read the bar is determinate: its width is done of total and it stops pulsing', () => {
    header(true, null, { done: 3, total: 12 });
    const inner = screen.getByTestId('download-progress').firstElementChild as HTMLElement;
    expect(inner.style.width).toBe('25%');
    expect(inner.className).not.toContain('animate-pulse');
  });

  it('the live line counts done of total, and adds the ETA once there is one', () => {
    header(true, null, { done: 3, total: 12 });
    expect(screen.getByTestId('refresh-summary')).toHaveTextContent('Downloading… 3 of 12');
    cleanup();
    header(true, null, { done: 3, total: 12 }, 20_000);
    expect(screen.getByTestId('refresh-summary')).toHaveTextContent('Downloading… 3 of 12 · about 20 seconds left');
  });

  it('the live line still says only Downloading… while the list is being read', () => {
    header(true, null, { done: 0, total: 0 });
    expect(screen.getByTestId('refresh-summary')).toHaveTextContent('Downloading…');
  });

  it('a finished download lists the inspections it could not fetch, under the summary', () => {
    header(false, 'Updated 2 inspections. 1 could not be downloaded.', null, null, ['12 Oak Street']);
    const list = screen.getByRole('list', { name: 'Inspections that could not be downloaded' });
    expect(list).toHaveTextContent('12 Oak Street');
    expect(screen.getByTestId('refresh-summary')).toHaveTextContent('Updated 2 inspections. 1 could not be downloaded.');
  });

  it('no list is rendered when nothing failed', () => {
    header(false, 'Updated 2 inspections.');
    expect(screen.queryByRole('list', { name: 'Inspections that could not be downloaded' })).toBeNull();
  });
});
