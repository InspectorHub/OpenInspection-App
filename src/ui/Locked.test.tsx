// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, restartOffline, rowCounts, seedLocalData, type World } from '../app/test-support/world';
import { DAY_MS } from '../offline/lock';
import { evaluateAndPersist, MAX_TENANT_NAME_LENGTH, setRevoked } from '../offline/lock-state';
import type { LockReason } from '../offline/lock';
import { Locked, type LockedProps } from './Locked';

afterEach(cleanup);

async function addMedia(world: World, id: string, state: string): Promise<void> {
  await world.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'i1', 'photo', `media/${id}.jpg`, 'image/jpeg', '{}', state, 1]);
  await world.files.write(`media/${id}.jpg`, new Uint8Array([1]));
}

async function addOutbox(world: World, key: string, seq: number, state: string): Promise<void> {
  await world.db.run('INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)', [key, seq, 'save', '{}', state, 1]);
}

function view(world: World, reason: LockReason, props: Partial<LockedProps> = {}) {
  const handlers = { onOutcome: vi.fn(), onSignInRequired: vi.fn(), onCleared: vi.fn() };
  render(<Locked services={world.services} origin={world.server.origin} reason={reason} {...handlers} {...props} />);
  return handlers;
}

describe('what the lock screen shows', () => {
  it('counts what is waiting: media pending, uploading and failed, outbox pending and failed; not uploaded or orphaned', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    await addMedia(world, 'm2', 'uploading');
    await addMedia(world, 'm3', 'failed');
    await addMedia(world, 'm4', 'uploaded');
    await addOutbox(world, 'o1', 1, 'pending');
    await addOutbox(world, 'o2', 2, 'failed');
    await addOutbox(world, 'o3', 3, 'orphaned');
    view(world, 'expired');
    expect(await screen.findByTestId('waiting-count')).toHaveTextContent('5 items waiting to upload');
  });

  it('says "1 item" for one, and zero for none', async () => {
    const world = await createSignedInWorld();
    view(world, 'expired');
    expect(await screen.findByTestId('waiting-count')).toHaveTextContent('0 items waiting to upload');
    cleanup();
    await addOutbox(world, 'o1', 1, 'pending');
    view(world, 'expired');
    expect(await screen.findByTestId('waiting-count')).toHaveTextContent('1 item waiting to upload');
  });

  it('expired: the reason, Verify online, Clear local data; no export without a handler', async () => {
    const world = await createSignedInWorld();
    view(world, 'expired');
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    expect(screen.getByText(/offline longer than your company allows/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify online' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear local data' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });

  it('clock: asks for the date and time to be corrected, and offers Verify online', async () => {
    const world = await createSignedInWorld();
    view(world, 'clock');
    expect(await screen.findByRole('heading', { name: 'Check your date and time' })).toBeInTheDocument();
    expect(screen.getByText(/Correct them in your device settings/i)).toBeInTheDocument();
    expect(screen.getByText(/verifying online can then re-check it when the server supports it/i)).toBeInTheDocument();
    expect(screen.queryByText(/and the app unlocks/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Verify online' })).toBeInTheDocument();
  });

  it('revoked: the company text, no verify, no upload wording', async () => {
    const world = await createSignedInWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('tenant_name', 'Acme Inspections')");
    await addOutbox(world, 'o1', 1, 'pending');
    view(world, 'revoked');
    expect(await screen.findByText('This data belongs to Acme Inspections. Export it and give it to your company, or clear it from this device.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify online' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear local data' })).toBeInTheDocument();
    expect(screen.getByTestId('waiting-count')).toHaveTextContent('1 item on this device was not uploaded');
    expect(screen.queryByText(/waiting to upload/i)).toBeNull();
  });

  it('revoked with no stored company name says "your company"', async () => {
    const world = await createSignedInWorld();
    view(world, 'revoked');
    expect(await screen.findByText('This data belongs to your company. Export it and give it to your company, or clear it from this device.')).toBeInTheDocument();
  });

  it('the company name is bounded and rendered as text, never as markup', async () => {
    const world = await createSignedInWorld();
    const evil = `<img src=x onerror=alert(1)>${'z'.repeat(200)}`;
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('tenant_name', ?)", [evil]);
    const { container } = render(<Locked services={world.services} origin={world.server.origin} reason="revoked" onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={vi.fn()} />);
    await screen.findByText(/This data belongs to /);
    expect(container.querySelector('img')).toBeNull();
    const shown = /This data belongs to (.*)\. Export it/.exec(container.textContent)?.[1] ?? '';
    expect(shown.length).toBeLessThanOrEqual(MAX_TENANT_NAME_LENGTH);
    expect(shown.startsWith('<img src=x')).toBe(true);
  });

  it('shows the export button only when an export is supplied, and calls it', async () => {
    const world = await createSignedInWorld();
    const onExport = vi.fn();
    view(world, 'revoked', { onExport });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Export unsent data' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});

describe('Verify online', () => {
  it('unlocks an expired device', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    const { onOutcome } = view(world, 'expired');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify online' }));
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ locked: false }));
  });

  it('a clock that is still behind stays locked and the screen says to fix the date and time', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(9_000_000);
    const { onOutcome } = view(world, 'clock');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify online' }));
    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ locked: true, reason: 'clock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still looks wrong/i);
  });

  it('offline: says so, keeps the screen, and the button works again', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    const offline = restartOffline(world);
    const onOutcome = vi.fn();
    render(<Locked services={offline.services} origin={world.server.origin} reason="expired" onOutcome={onOutcome} onSignInRequired={vi.fn()} onCleared={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Verify online' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(onOutcome).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Verify online' })).toBeEnabled();
  });

  it('a refused session sends the person to sign in, keeping the data', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    world.clock.advance(31 * DAY_MS);
    world.server.revokeAllGrants();
    const { onSignInRequired } = view(world, 'expired');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify online' }));
    await waitFor(() => expect(onSignInRequired).toHaveBeenCalledTimes(1));
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('two taps in one frame start one verification', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    const { onOutcome } = view(world, 'expired');
    const button = await screen.findByRole('button', { name: 'Verify online' });
    const sessionChecksBefore = world.server.count('/api/client/session');
    button.click();
    button.click();
    await waitFor(() => expect(onOutcome).toHaveBeenCalled());
    expect(world.server.count('/api/client/session') - sessionChecksBefore).toBe(1);
  });
});

describe('Clear local data', () => {
  it('asks first with a custom dialog and clears nothing until confirmed', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { onCleared } = view(world, 'expired');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Clear local data' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Clear local data?');
    expect(dialog).toHaveAccessibleDescription(/permanently removes/i);
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/i);
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('Cancel closes the dialog and keeps everything', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { onCleared } = view(world, 'expired');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('never uses window.confirm', async () => {
    const world = await createSignedInWorld();
    const confirm = vi.spyOn(window, 'confirm');
    view(world, 'expired');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirming clears the data and files, signs the token out, and leaves the server to sign in again', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    await addMedia(world, 'mm', 'pending');
    const { onCleared } = view(world, 'revoked');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    const counts = await rowCounts(world.db);
    for (const table of ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package']) expect(counts[table]).toBe(0);
    expect(world.files.paths()).toEqual([]);
    const kept = await world.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'server_url'");
    expect(kept[0]?.value).toBe(world.server.origin);
    expect(Object.keys(world.store.entries())).toEqual([]);
  });

  it('a double tap on the confirm button clears once', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    const { onCleared } = view(world, 'expired');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Clear local data' }));
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('files that cannot be removed are reported on a follow-up screen before moving on', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'stuck', 'pending');
    world.files.failRemoveFor('media/stuck.jpg');
    const { onCleared } = view(world, 'expired');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByRole('heading', { name: 'Local data cleared' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 item could not be removed');
    expect(onCleared).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('a database failure keeps the dialog open with a fixed message', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const failingDb = { ...world.db, run: () => Promise.reject(new Error('SERVER-OR-DISK-TEXT')) };
    const onCleared = vi.fn();
    render(<Locked services={{ ...world.services, db: failingDb }} origin={world.server.origin} reason="expired" onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={onCleared} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Delete everything' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Local data could not be cleared. Try again.');
    expect(screen.queryByText(/SERVER-OR-DISK-TEXT/)).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
  });
});

describe('Clear local data: a second question when something has not reached the server', () => {
  async function startClear(world: World, reason: LockReason = 'expired') {
    const handlers = view(world, reason);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    return { ...handlers, user };
  }

  it('unsent photos: the first confirmation only counts; the second dialog names what would be lost and nothing is removed yet', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    await addMedia(world, 'm2', 'failed');
    const before = await rowCounts(world.db);
    const { onCleared } = await startClear(world);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete 2 items that are not uploaded?' });
    expect(within(dialog).getByTestId('at-risk')).toHaveTextContent('2 photos, clips and changes not uploaded');
    expect(dialog).toHaveAccessibleDescription(/exist only on this device/);
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
    expect(world.files.paths()).toHaveLength(2);
  });

  it('a photo kept after a failed upload counts as lost data, the same as one waiting', async () => {
    const world = await createSignedInWorld();
    await world.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['kept', 'i1', 'photo', 'media/kept.jpg', 'image/jpeg', '{}', 'failed', 3, 1]);
    await startClear(world);
    expect(await screen.findByRole('alertdialog', { name: 'Delete 1 item that is not uploaded?' })).toBeInTheDocument();
  });

  it('"Keep my data" closes the second question and removes nothing', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    const before = await rowCounts(world.db);
    const { onCleared, user } = await startClear(world);
    await user.click(within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Keep my data' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('the second confirmation clears the data and files, signs the token out and ends on sign-in', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    const { onCleared, user } = await startClear(world, 'revoked');
    await user.click(within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect((await rowCounts(world.db)).media).toBe(0);
    expect(world.files.paths()).toEqual([]);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a double tap on the second confirmation clears once', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    const { onCleared } = await startClear(world);
    const confirm = within(await screen.findByRole('alertdialog', { name: /not uploaded\?$/ })).getByRole('button', { name: 'Delete everything' });
    confirm.click();
    confirm.click();
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a count that cannot be made is treated as unsent data: the second question says so and still removes nothing', async () => {
    const world = await createSignedInWorld();
    await addMedia(world, 'm1', 'pending');
    const before = await rowCounts(world.db);
    const unreadable = { ...world.db, query: () => Promise.reject(new Error('SERVER-OR-DISK-TEXT')) };
    const onCleared = vi.fn();
    render(<Locked services={{ ...world.services, db: unreadable }} origin={world.server.origin} reason="expired" onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={onCleared} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete data that may not be uploaded?' });
    expect(within(dialog).getByText(/could not count what has not been uploaded/)).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-OR-DISK-TEXT/)).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('control: with nothing unsent one confirmation clears', async () => {
    const world = await createSignedInWorld();
    const { onCleared } = await startClear(world);
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog', { name: /not uploaded\?$/ })).toBeNull();
  });
});

describe('showing the lock screen deletes nothing', () => {
  it('row counts are unchanged after rendering each reason', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await setRevoked(world.db);
    const before = await rowCounts(world.db);
    for (const reason of ['expired', 'clock', 'revoked'] as const) {
      view(world, reason);
      await screen.findByTestId('waiting-count');
      cleanup();
    }
    expect(await rowCounts(world.db)).toEqual(before);
  });
});
