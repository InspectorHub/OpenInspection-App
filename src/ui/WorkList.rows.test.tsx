// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, NOW, seedCached, seedMedia, seedPkg, seedQueued, seedRefreshError, seedTenantName, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

const rowOf = async (id: string): Promise<HTMLElement> => screen.findByTestId(`row-${id}`);

describe('WorkList: loading, empty, error', () => {
  it('shows a busy skeleton before the first read finishes, then the list', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    const loading = screen.getByRole('status', { name: 'Loading your work list' });
    expect(loading).toHaveAttribute('aria-busy', 'true');
    await rowOf('a');
    expect(screen.queryByRole('status', { name: 'Loading your work list' })).toBeNull();
  });

  it('says what to do when nothing is downloaded yet', async () => {
    renderList(w.stack);
    expect(await screen.findByText("No inspections downloaded yet. Connect to the internet and tap Download today's work.")).toBeInTheDocument();
    expect(screen.getByText('Not updated yet')).toBeInTheDocument();
  });

  it('a failed read shows a fixed message and a retry that reads again', async () => {
    const real = w.db.query.bind(w.db);
    let fail = true;
    vi.spyOn(w.db, 'query').mockImplementation((sql: string, params?: unknown[]) => (fail ? Promise.reject(new Error('disk says: secret detail')) : real(sql, params)));
    renderList(w.stack);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not read the work list from this device.');
    expect(alert).not.toHaveTextContent('secret detail');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("No inspections downloaded yet. Connect to the internet and tap Download today's work.")).toBeInTheDocument();
  });
});

describe('WorkList: header', () => {
  it('shows the title and a relative update time from the newest package', async () => {
    await seedPkg(w.db, { id: 'a', refreshedAt: NOW - 5 * 60_000, scheduledAt: at(0) });
    renderList(w.stack);
    expect(await screen.findByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(screen.getByText('Updated 5 minutes ago')).toBeInTheDocument();
  });
});

describe('WorkList: grouping and row content', () => {
  it('groups rows under Today, Tomorrow, Later, Earlier and Not scheduled, in that order', async () => {
    for (const [id, scheduledAt] of [['u', null], ['e', at(-1)], ['l', at(3)], ['m', at(1)], ['t', at(0)]] as const) await seedPkg(w.db, { id, scheduledAt });
    renderList(w.stack);
    await rowOf('t');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Today', 'Tomorrow', 'Later', 'Earlier', 'Not scheduled']);
    expect(within(screen.getByRole('region', { name: 'Tomorrow' })).getByTestId('row-m')).toBeInTheDocument();
  });

  it('shows the cached address as the title, or the short id when there is none', async () => {
    await seedPkg(w.db, { id: 'abcdefghijkl', scheduledAt: at(0) });
    await seedCached(w.db, 'abcdefghijkl', '12 Oak Street');
    await seedPkg(w.db, { id: 'zyxwvutsrqpo', scheduledAt: at(0) });
    renderList(w.stack);
    expect(within(await rowOf('abcdefghijkl')).getByRole('heading', { level: 3 })).toHaveTextContent('12 Oak Street');
    expect(within(await rowOf('zyxwvutsrqpo')).getByRole('heading', { level: 3 })).toHaveTextContent('Inspection zyxwvuts');
  });

  it('renders an address as text, never as markup', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedCached(w.db, 'a', '<img src=x onerror=alert(1)>');
    renderList(w.stack);
    const row = await rowOf('a');
    expect(row.querySelector('img')).toBeNull();
    expect(row).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('Downloaded and Not downloaded yet come from the cached resources', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0), refreshedAt: NOW });
    await seedCached(w.db, 'a', 'A');
    await seedPkg(w.db, { id: 'b', scheduledAt: at(0) });
    renderList(w.stack);
    expect(within(await rowOf('a')).getByText('Downloaded')).toBeInTheDocument();
    expect(within(await rowOf('b')).getByText('Not downloaded yet')).toBeInTheDocument();
    expect(within(await rowOf('b')).queryByText('Downloaded')).toBeNull();
  });

  it('Waiting to upload counts queued writes and photos; failed items are a separate badge; orphaned items a separate line', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'a' });
    await seedMedia(w.db, 'm1', 'a', 'pending');
    await seedMedia(w.db, 'm2', 'a', 'failed');
    await seedQueued(w.db, { key: 'k2', seq: 2, inspectionId: 'a', state: 'failed', error: 'rejected' });
    await seedQueued(w.db, { key: 'k3', seq: 3, inspectionId: 'a', state: 'orphaned', error: 'target_gone' });
    await seedQueued(w.db, { key: 'k4', seq: 4, inspectionId: 'a', state: 'orphaned', error: 'target_gone' });
    renderList(w.stack);
    const row = await rowOf('a');
    expect(within(row).getByText('Waiting to upload: 2')).toBeInTheDocument();
    expect(within(row).getByText('2 need attention')).toBeInTheDocument();
    expect(within(row).getByText('2 items belong to an inspection that is no longer on your list')).toBeInTheDocument();
  });

  it('a row with nothing waiting shows no waiting badge', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    expect(within(await rowOf('a')).queryByText(/Waiting to upload/)).toBeNull();
  });

  it('a refresh error shows its fixed text for every code, never server text', async () => {
    const codes: Record<string, string> = {
      not_found: 'The server did not find this inspection during the last download.',
      refused: 'The server refused the last download.',
      invalid_response: 'The server sent an answer the app could not use.',
      too_large: 'The last download was too large to keep.',
      rate_limited: 'The server asked the app to slow down. It will try again.',
      server_error: 'The server had a problem during the last download.',
      network: 'The last download was interrupted. It will try again.',
      storage_failed: 'The last download could not be saved. Free up storage.',
    };
    for (const code of Object.keys(codes)) {
      await seedPkg(w.db, { id: code, scheduledAt: at(0) });
      await seedRefreshError(w.db, code, code);
    }
    renderList(w.stack);
    for (const [code, text] of Object.entries(codes)) expect(within(await rowOf(code)).getByText(text)).toBeInTheDocument();
  });

  it('a package made on this device and not yet sent says so', async () => {
    await seedPkg(w.db, { id: 'n', scheduledAt: at(0), confirmed: 0 });
    renderList(w.stack);
    expect(within(await rowOf('n')).getByText('Created on this device, not yet sent')).toBeInTheDocument();
  });
});

describe('WorkList: pin', () => {
  it('toggles the pin in the database and the button reports its state', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    const user = userEvent.setup();
    const pin = within(await rowOf('a')).getByRole('button', { name: /^Pin/ });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await user.click(pin);
    await waitFor(() => expect(within(screen.getByTestId('row-a')).getByRole('button', { name: /^Pin/ })).toHaveAttribute('aria-pressed', 'true'));
    expect((await w.db.query<{ pinned: number }>('SELECT pinned FROM work_package WHERE inspection_id = ?', ['a']))[0]?.pinned).toBe(1);
    expect(within(screen.getByTestId('row-a')).getByText('Pinned', { selector: 'span' })).toBeInTheDocument();
    await user.click(within(screen.getByTestId('row-a')).getByRole('button', { name: /^Pin/ }));
    await waitFor(() => expect(within(screen.getByTestId('row-a')).getByRole('button', { name: /^Pin/ })).toHaveAttribute('aria-pressed', 'false'));
    expect((await w.db.query<{ pinned: number }>('SELECT pinned FROM work_package WHERE inspection_id = ?', ['a']))[0]?.pinned).toBe(0);
  });

  it('offers no pin on a quarantined, removing or not-yet-sent row', async () => {
    await seedPkg(w.db, { id: 'q', quarantine: 'reconcile_missing' });
    await seedPkg(w.db, { id: 'r', purging: 1 });
    await seedPkg(w.db, { id: 'c', confirmed: 0 });
    renderList(w.stack);
    for (const id of ['q', 'r', 'c']) expect(within(await rowOf(id)).queryByRole('button', { name: /^Pin/ })).toBeNull();
  });

  it('two taps in one frame write once', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    const run = vi.spyOn(w.db, 'run');
    const pin = within(await rowOf('a')).getByRole('button', { name: /^Pin/ });
    pin.click();
    pin.click();
    await waitFor(() => expect(within(screen.getByTestId('row-a')).getByRole('button', { name: /^Pin/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(run.mock.calls.filter(([sql]) => /UPDATE work_package SET pinned/.test(sql))).toHaveLength(1);
  });

  it('a pin the database refuses leaves the button as it was and says why', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    const pin = within(await rowOf('a')).getByRole('button', { name: /^Pin/ });
    await w.db.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = 'a'");
    await userEvent.setup().click(pin);
    expect(await screen.findByText('This inspection cannot be pinned right now.')).toBeInTheDocument();
    expect((await w.db.query<{ pinned: number }>('SELECT pinned FROM work_package'))[0]?.pinned).toBe(0);
  });
});

describe('WorkList: opening a row', () => {
  it('a normal row calls onOpenInspection with its id', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    const onOpenInspection = vi.fn();
    renderList(w.stack, { onOpenInspection });
    await userEvent.setup().click(within(await rowOf('a')).getByRole('button', { name: /^Open/ }));
    expect(onOpenInspection).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('a quarantined or removing row is inert: aria-disabled and no call', async () => {
    await seedPkg(w.db, { id: 'q', quarantine: 'reconcile_missing' });
    await seedPkg(w.db, { id: 'r', purging: 2 });
    const onOpenInspection = vi.fn();
    renderList(w.stack, { onOpenInspection });
    const user = userEvent.setup();
    for (const id of ['q', 'r']) {
      const open = within(await rowOf(id)).getByRole('button', { name: /^Open/ });
      expect(open).toHaveAttribute('aria-disabled', 'true');
      await user.click(open);
    }
    expect(onOpenInspection).not.toHaveBeenCalled();
  });

  it('without a handler the default does nothing and does not throw', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    await userEvent.setup().click(within(await rowOf('a')).getByRole('button', { name: /^Open/ }));
    expect(screen.getByTestId('row-a')).toBeInTheDocument();
  });
});

describe('WorkList: quarantined rows and their wording', () => {
  async function quarantined(count = 1): Promise<void> {
    for (let i = 1; i <= count; i += 1) await seedPkg(w.db, { id: `q${String(i)}`, scheduledAt: at(0), quarantine: 'reconcile_missing' });
  }

  it('each quarantined row has its own persistent banner with the or-wording', async () => {
    await quarantined();
    renderList(w.stack);
    const row = await rowOf('q1');
    expect(within(row).getByText('Quarantined')).toBeInTheDocument();
    expect(row).toHaveTextContent('No longer assigned to you or removed from the server.');
    expect(row).toHaveTextContent('If anything on this inspection was not sent, it is still on this device.');
  });

  it('never says deleted, and never recommends a legal action', async () => {
    await quarantined(2);
    await seedQueued(w.db, { key: 'k1', seq: 1, inspectionId: 'q1', state: 'orphaned', error: 'target_gone' });
    renderList(w.stack, { onExport: vi.fn() });
    await rowOf('q1');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bdeleted\b/i);
    expect(text).not.toMatch(/legal|lawyer|counsel|law\b|liab/i);
  });

  it('a summary banner counts them, singular and plural', async () => {
    await quarantined(2);
    const first = renderList(w.stack);
    expect(await screen.findByText('2 inspections are no longer on your list. If anything on them was not sent, it is still on this device.')).toBeInTheDocument();
    first.unmount();
    await w.db.run("DELETE FROM work_package WHERE inspection_id = 'q2'");
    renderList(w.stack);
    expect(await screen.findByText('1 inspection is no longer on your list. If anything on it was not sent, it is still on this device.')).toBeInTheDocument();
  });

  it('no summary banner when nothing is quarantined', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    await rowOf('a');
    expect(screen.queryByText(/no longer on your list\. (Their|Its) unsent data/)).toBeNull();
  });

  it('a pinned quarantined row still shows the banner', async () => {
    await seedPkg(w.db, { id: 'q1', scheduledAt: at(0), quarantine: 'reconcile_missing', pinned: 1 });
    renderList(w.stack);
    const row = await rowOf('q1');
    expect(within(row).getByText('Pinned', { selector: 'span' })).toBeInTheDocument();
    expect(row).toHaveTextContent('No longer assigned to you or removed from the server.');
  });

  it('a quarantined row offers Remove from this device and, with no export handler, no export button', async () => {
    await quarantined();
    renderList(w.stack);
    const row = await rowOf('q1');
    expect(within(row).getByRole('button', { name: 'Remove from this device' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /export/i })).toBeNull();
    expect(row).not.toHaveTextContent('not encrypted');
  });

  it('with an export handler the export button and the responsibility wording appear together, naming the company', async () => {
    await quarantined();
    await seedTenantName(w.db, 'Acme Inspections');
    const onExport = vi.fn();
    renderList(w.stack, { onExport });
    const row = await rowOf('q1');
    expect(row).toHaveTextContent('This file contains customer personal information and is not encrypted. Keeping and deleting it is the responsibility of Acme Inspections.');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Export unsent data' }));
    expect(onExport).toHaveBeenCalledExactlyOnceWith('q1');
  });

  it('without a company name the wording says your company', async () => {
    await quarantined();
    renderList(w.stack, { onExport: vi.fn() });
    expect(await rowOf('q1')).toHaveTextContent('responsibility of your company.');
  });

  it('a healthy row has no Remove action and no export', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack, { onExport: vi.fn() });
    const row = await rowOf('a');
    expect(within(row).queryByRole('button', { name: /remove/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('a row being removed shows Removing and offers nothing', async () => {
    await seedPkg(w.db, { id: 'r', scheduledAt: at(0), purging: 2 });
    renderList(w.stack);
    const row = await rowOf('r');
    expect(within(row).getByText('Removing…')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /remove from/i })).toBeNull();
  });
});

describe('WorkList: refreshes from the database', () => {
  it('re-reads when the stack status changes', async () => {
    const { stack, status } = withStatus(w.stack);
    renderList(stack);
    await screen.findByText('Not updated yet');
    await seedPkg(w.db, { id: 'late', scheduledAt: at(0) });
    status.patch({ collabIssue: true });
    expect(await screen.findByTestId('row-late')).toBeInTheDocument();
  });

  it('polls the database at the given interval while visible', async () => {
    renderList(w.stack, { pollMs: 20 });
    await screen.findByText('Not updated yet');
    await seedPkg(w.db, { id: 'polled', scheduledAt: at(0) });
    expect(await screen.findByTestId('row-polled')).toBeInTheDocument();
  });

  it('does not poll while the page is hidden', async () => {
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    renderList(w.stack, { pollMs: 20 });
    await screen.findByText('Not updated yet');
    await seedPkg(w.db, { id: 'quiet', scheduledAt: at(0) });
    const query = vi.spyOn(w.db, 'query');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(query).not.toHaveBeenCalled();
    expect(screen.queryByTestId('row-quiet')).toBeNull();
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByTestId('row-quiet')).toBeInTheDocument();
    Reflect.deleteProperty(document, 'visibilityState');
  });
});

describe('WorkList: accessibility', () => {
  it('groups are labelled regions, rows are list items, and every control has a name', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    await seedPkg(w.db, { id: 'q', scheduledAt: at(1), quarantine: 'reconcile_missing' });
    renderList(w.stack);
    await rowOf('a');
    expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
  });

  it('every interactive control is at least 44 px tall by class', async () => {
    await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
    renderList(w.stack);
    await rowOf('a');
    for (const button of screen.getAllByRole('button')) expect(button.className).toMatch(/min-h-11|h-11|min-h-\[44px\]/);
  });
});
