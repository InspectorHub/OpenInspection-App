// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData, type World } from '../app/test-support/world';
import type { Db } from '../platform/db';
import { CLEAR_FAILED, ClearLocalDataControl } from './ClearLocalDataControl';

afterEach(cleanup);

function mount(world: World, db: Db = world.db) {
  const onCleared = vi.fn();
  const signOut = vi.spyOn(world.services.tokens, 'signOut');
  render(<ClearLocalDataControl services={{ ...world.services, db }} origin={world.server.origin} onCleared={onCleared} />);
  return { onCleared, signOut, user: userEvent.setup() };
}

/** A database whose first read of the media table waits for `release()`. */
function gatedDb(db: Db, holdNth = 1) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seen = 0;
  const wrapped: Db = {
    ...db,
    query: <T,>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('FROM media') && (seen += 1) === holdNth) {
        return gate.then(() => db.query<T>(sql, params));
      }
      return db.query<T>(sql, params);
    },
  };
  return { db: wrapped, release: () => release() };
}

async function unsyncedDoc(db: Db, id: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getMap('results').set('k', 'v');
  await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [`results-${id}`, Y.encodeStateAsUpdate(doc)]);
}

describe('edits that the server does not have', () => {
  it('"everything uploaded" is never said while a document holds edits the server has not been shown to have; the two-step path is required', async () => {
    const world = await createSignedInWorld();
    await unsyncedDoc(world.db, 'a');
    const before = await rowCounts(world.db);
    const { user, onCleared } = mount(world);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByTestId('at-risk')).toBeInTheDocument());
    expect(dialog).toHaveTextContent('1 inspection with edits not yet on the server');
    expect(dialog).not.toHaveTextContent('Everything on this device has been uploaded.');
    expect(within(dialog).queryByRole('button', { name: 'Clear local data' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('Delete 1 item that is not uploaded?');
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });
});

describe('the count must settle before anything can be confirmed', () => {
  it('the confirm button is disabled from the first frame until the count answers (control: it enables after)', async () => {
    const world = await createSignedInWorld();
    const gated = gatedDb(world.db);
    const { user } = mount(world, gated.db);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeDisabled();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Counting');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeDisabled();
    await act(async () => gated.release());
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
  });

  it('a slow count from an earlier opening does not change the dialog of the new one', async () => {
    const world = await createSignedInWorld();
    const gated = gatedDb(world.db);
    const { user } = mount(world, gated.db);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(dialog).toHaveTextContent('Everything on this device has been uploaded.'));
    await seedLocalData(world.db);
    await act(async () => gated.release());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dialog).toHaveTextContent('Everything on this device has been uploaded.');
    expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled();
    expect(within(dialog).queryByTestId('at-risk')).toBeNull();
  });
});

describe('a second opening', () => {
  it('counts again from the first frame: the answer of the earlier opening is not shown while the new count runs', async () => {
    const world = await createSignedInWorld();
    const gated = gatedDb(world.db, 2);
    const { user } = mount(world, gated.db);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const first = await screen.findByRole('alertdialog');
    await waitFor(() => expect(first).toHaveTextContent('Everything on this device has been uploaded.'));
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    await seedLocalData(world.db);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const second = screen.getByRole('alertdialog');
    expect(second).toHaveTextContent('Counting');
    expect(second).not.toHaveTextContent('Everything on this device has been uploaded.');
    expect(within(second).getByRole('button', { name: /Clear local data|Continue/ })).toBeDisabled();
    await act(async () => gated.release());
    await waitFor(() => expect(within(second).getByRole('button', { name: 'Continue' })).toBeEnabled());
  });
});

describe('clearing', () => {
  it('two taps in one frame clear once: one sign-out, one report (control: a tap after a failure still works)', async () => {
    const world = await createSignedInWorld();
    const { user, onCleared, signOut } = mount(world);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
    const button = within(dialog).getByRole('button', { name: 'Clear local data' });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('two taps on the second step also clear once', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    const { user, onCleared, signOut } = mount(world);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const button = await screen.findByRole('button', { name: 'Delete everything' });
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a clear that throws says so in a fixed sentence, leaves the dialog open, and a second tap can succeed', async () => {
    const world = await createSignedInWorld();
    let fail = true;
    const flaky: Db = { ...world.db, run: (sql, params) => (fail && /DELETE FROM ydoc_updates/.test(sql) ? Promise.reject(new Error('disk full, secret')) : world.db.run(sql, params)) };
    const { user, onCleared } = mount(world, flaky);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(CLEAR_FAILED);
    expect(dialog).not.toHaveTextContent('secret');
    expect(onCleared).not.toHaveBeenCalled();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
  });

  it('work that arrives while the one-step dialog is open sends the person to the second step instead of being removed', async () => {
    const world = await createSignedInWorld();
    const { user, onCleared } = mount(world);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
    const second = await screen.findByRole('alertdialog', { name: /not uploaded\?/ });
    expect(second).toHaveTextContent('not uploaded');
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('removes export archives and orphan photo files with the data, and leaves files that are not ours', async () => {
    const world = await createSignedInWorld();
    world.clock.set(1_800_000_000_000);
    world.files.seedCache(`inspectorhub-export-${String(world.clock.now() - 1000)}.zip`, null);
    world.files.seedCache('unrelated.zip', null);
    await world.files.write('media/orphan.jpg', new Uint8Array([1]));
    await world.files.write('media/readme.txt', new Uint8Array([1]));
    const { user, onCleared } = mount(world);
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear local data' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(world.files.cacheNames()).toEqual(['unrelated.zip']);
    expect(world.files.paths()).toEqual(['media/readme.txt']);
  });
});
