// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld } from '../app/test-support/world';
import type { Db } from '../platform/db';
import { CLEAR_FAILED, ClearLocalDataControl } from './ClearLocalDataControl';

afterEach(cleanup);

async function clickClear(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Clear local data' }));
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
  await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
  return user;
}

describe('the wiping flag of the clear', () => {
  it('goes true before the data is removed and stays true after a clear that worked (the app leaves for sign-in)', async () => {
    const world = await createSignedInWorld();
    const seen: boolean[] = [];
    const onWiping = vi.fn((wiping: boolean) => seen.push(wiping));
    const onCleared = vi.fn();
    render(<ClearLocalDataControl services={world.services} origin={world.server.origin} onCleared={onCleared} onWiping={onWiping} />);
    await clickClear();
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([true]);
  });

  it('goes back to false when the clear failed, so the lock checks resume (control: a second try says true again)', async () => {
    const world = await createSignedInWorld();
    let fail = true;
    const flaky: Db = { ...world.db, run: (sql, params) => (fail && /DELETE FROM ydoc_updates/.test(sql) ? Promise.reject(new Error('disk full')) : world.db.run(sql, params)) };
    const seen: boolean[] = [];
    render(<ClearLocalDataControl services={{ ...world.services, db: flaky }} origin={world.server.origin} onCleared={vi.fn()} onWiping={(wiping) => seen.push(wiping)} />);
    const user = await clickClear();
    expect(await screen.findByRole('alert')).toHaveTextContent(CLEAR_FAILED);
    expect(seen).toEqual([true, false]);
    fail = false;
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(seen).toEqual([true, false, true]));
  });
});
