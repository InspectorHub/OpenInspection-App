// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkListHeader } from './WorkListHeader';

afterEach(cleanup);

function header(downloading: boolean, summary: string | null = null) {
  return render(
    <WorkListHeader updatedAt={1000} now={2000} locale="en-US" chip={null} downloading={downloading} summary={summary} onDownload={() => undefined} headingRef={() => undefined} onSettings={() => undefined} settingsRef={() => undefined} />,
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
    expect(note.className).toContain('sr-only');
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
});
