// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedPkg, type ListWorld } from './test-support/worklist-world';
import { RowBoundary } from './worklist/RowBoundary';

const SECRET = 'render-secret-detail';

vi.mock('./worklist/InspectionRow', async (importOriginal) => {
  const real = await importOriginal<typeof import('./worklist/InspectionRow')>();
  return {
    ...real,
    InspectionRow: (props: Parameters<typeof real.InspectionRow>[0]) => {
      if (props.row.id === 'broken0001') throw new Error(SECRET);
      return real.InspectionRow(props);
    },
  };
});

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
  // React reports an error caught by a boundary to the console; this test is about what the screen shows.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a row that fails to render does not blank the screen', () => {
  it('shows a fixed line for that row and keeps every other row, the header and the panels', async () => {
    await seedPkg(w.db, { id: 'before001', scheduledAt: at(0, 9) });
    await seedPkg(w.db, { id: 'broken0001', scheduledAt: at(0, 10) });
    await seedPkg(w.db, { id: 'after0001', scheduledAt: at(0, 11) });
    renderList(w.stack);
    expect(await screen.findByTestId('row-before001')).toBeInTheDocument();
    expect(screen.getByTestId('row-after0001')).toBeInTheDocument();
    expect(screen.queryByTestId('row-broken0001')).toBeNull();
    expect(screen.getByText('This inspection could not be displayed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Work list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Download today's work" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('the fixed line is a list item, so the list stays a list', async () => {
    await seedPkg(w.db, { id: 'broken0001', scheduledAt: at(0, 10) });
    renderList(w.stack);
    const line = await screen.findByText('This inspection could not be displayed');
    expect(line.tagName).toBe('LI');
  });
});

describe('RowBoundary', () => {
  function Bomb(): never {
    throw new Error(SECRET);
  }

  it('renders its children when nothing fails', () => {
    render(
      <ul>
        <RowBoundary>
          <li>fine</li>
        </RowBoundary>
      </ul>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
    expect(screen.queryByText('This inspection could not be displayed')).toBeNull();
  });

  it('replaces a failing child by the fixed line and shows nothing of the error', () => {
    render(
      <ul>
        <RowBoundary>
          <Bomb />
        </RowBoundary>
      </ul>,
    );
    expect(screen.getByText('This inspection could not be displayed')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });
});
