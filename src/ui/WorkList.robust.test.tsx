// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedCached, seedMedia, seedPkg, seedQueued, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

describe('a stored date that cannot be used does not blank the screen', () => {
  it.each([
    ['1e16', 1e16],
    ['-1e16', -1e16],
    ['negative', -5],
  ])('scheduled_at %s: every row still renders', async (_name, value) => {
    await seedPkg(w.db, { id: 'odd', scheduledAt: value });
    await seedPkg(w.db, { id: 'fine', scheduledAt: at(0) });
    renderList(w.stack);
    expect(await screen.findByTestId('row-fine')).toBeInTheDocument();
    expect(screen.getByTestId('row-odd')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Work list' })).toBeInTheDocument();
  });

  it.each([
    ['1e16', 1e16],
    ['-1e16', -1e16],
  ])('scheduled_at %s says the date is unavailable, in Not scheduled', async (_name, value) => {
    await seedPkg(w.db, { id: 'odd', scheduledAt: value });
    renderList(w.stack);
    const row = await screen.findByTestId('row-odd');
    expect(within(row).getByText('Date unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Not scheduled' })).toBeInTheDocument();
  });

  it('scheduled_at stored as text that is not a number: the row renders and says the date is unavailable', async () => {
    await seedPkg(w.db, { id: 'text', scheduledAt: 0 });
    await w.db.run("UPDATE work_package SET scheduled_at = 'tomorrow at noon' WHERE inspection_id = 'text'");
    await seedPkg(w.db, { id: 'fine', scheduledAt: at(0) });
    renderList(w.stack);
    const row = await screen.findByTestId('row-text');
    expect(within(row).getByText('Date unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('row-fine')).toBeInTheDocument();
  });

  it('scheduled_at stored as text that is a number is read as that number', async () => {
    await seedPkg(w.db, { id: 'numtext', scheduledAt: 0 });
    await w.db.run('UPDATE work_package SET scheduled_at = ? WHERE inspection_id = ?', [String(at(0)), 'numtext']);
    renderList(w.stack);
    const row = await screen.findByTestId('row-numtext');
    expect(within(row).queryByText('Date unavailable')).toBeNull();
    expect(within(row).getByText('3:00 PM')).toBeInTheDocument();
  });

  it('a refresh time that is not a number leaves the header readable', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0), refreshedAt: 1e16 });
    renderList(w.stack);
    await screen.findByTestId('row-a');
    expect(screen.getByRole('heading', { name: 'Work list' })).toBeInTheDocument();
  });
});

describe('long and strange titles', () => {
  const LONG = `${'W'.repeat(100)} Street`;

  it('a title with direction controls is shown without them', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedCached(w.db, 'a', '‮gnirts‬ 12 Elm');
    renderList(w.stack);
    const row = await screen.findByTestId('row-a');
    expect(within(row).getByRole('button', { name: 'Open gnirts 12 Elm' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[‪-‮⁦-⁩‎‏]/);
  });

  it('wraps a title that has no break points: in the row, in the Needs attention lines and in badges', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedCached(w.db, 'a', LONG);
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a', state: 'failed', error: 'rejected' });
    await seedMedia(w.db, 'm1', 'a', 'failed');
    renderList(w.stack);
    const row = await screen.findByTestId('row-a');
    const open = within(row).getByRole('button', { name: `Open ${LONG}` });
    expect(open.className).toContain('break-words');
    expect(open.className).toContain('[overflow-wrap:anywhere]');
    const area = await screen.findByRole('region', { name: 'Needs attention' });
    const lines = within(area).getAllByText(LONG);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.className).toContain('break-words');
      expect(line.className).toContain('[overflow-wrap:anywhere]');
    }
    const badge = within(row).getByText('Downloaded');
    expect(badge.className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('the quarantine wording does not promise data that may not exist', () => {
  it('says "if anything was not sent", never that unsent data is there', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    const row = await screen.findByTestId('row-q1');
    expect(row).toHaveTextContent('If anything on this inspection was not sent, it is still on this device. It can no longer be edited or sent.');
    expect(document.body.textContent).not.toMatch(/Your unsent data|Its unsent data|Their unsent data/);
    expect(document.body.textContent).not.toMatch(/\bdeleted\b/i);
  });
});
