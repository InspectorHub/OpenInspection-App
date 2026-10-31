// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeNetwork } from '../offline/test-support/replay-world';
import { SERVER_UNREACHABLE_TEXT, SYNC_PAUSED_TEXT } from './worklist/copy';
import { renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, seedPkg, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
});
afterEach(cleanup);

const SIGN_IN = 'Sign in again to keep syncing';
const line = () => screen.getByTestId('server-line');
const unknownNetwork = { online: () => new Promise<boolean>(() => undefined), onChange: () => () => undefined };

describe('the server cannot be reached while the device has a network', () => {
  it('says so in plain words, shows the chip as Server unreachable (not Online), and does not ask for a sign-in', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SERVER_UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(SERVER_UNREACHABLE_TEXT).toBe("The server can't be reached right now. Your work is saved on this device and will sync when it is back.");
    expect(screen.getByText('Server unreachable')).toBeInTheDocument();
    expect(screen.queryByText('Online')).toBeNull();
    expect(screen.queryByText(SIGN_IN)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the same chip with no network port (the page-event path), and Online again once the stack recovers', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, {});
    expect(await screen.findByText('Server unreachable')).toBeInTheDocument();
    act(() => {
      held.status.patch({ serverUnreachable: false });
    });
    await waitFor(() => expect(screen.getByText('Online')).toBeInTheDocument());
    expect(screen.queryByText('Server unreachable')).toBeNull();
  });

  it('shows Sync paused on the chip while the link is up', async () => {
    const held = withStatus(w.stack, { syncPaused: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText('Sync paused')).toBeInTheDocument();
    expect(screen.queryByText('Online')).toBeNull();
  });

  it('goes away on its own when the stack reports the next answer', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    await screen.findByText(SERVER_UNREACHABLE_TEXT);
    act(() => {
      held.status.patch({ serverUnreachable: false });
    });
    await waitFor(() => expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull());
  });

  it('is not shown while the device itself is offline: the chip already says so', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(false) });
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
  });

  it('is shown while the network state is not known yet (null counts as having one), and the chip is not shown', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, { network: unknownNetwork });
    await screen.findByTestId('row-a');
    expect(screen.getByText(SERVER_UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('Online')).toBeNull();
    expect(screen.queryByText('Offline')).toBeNull();
  });
});

describe('sync is paused (the server answered but not usefully, or storage failed)', () => {
  it('says so in plain words, and neither asks for a sign-in nor calls the server unreachable', async () => {
    const held = withStatus(w.stack, { syncPaused: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SYNC_PAUSED_TEXT)).toBeInTheDocument();
    expect(SYNC_PAUSED_TEXT).toBe('Sync is paused. The app will try again shortly.');
    expect(screen.queryByText(SIGN_IN)).toBeNull();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
  });

  it('is shown even while the device is offline: it is about the answer or the storage, not the link', async () => {
    const held = withStatus(w.stack, { syncPaused: true });
    renderList(held.stack, { network: fakeNetwork(false) });
    expect(await screen.findByText(SYNC_PAUSED_TEXT)).toBeInTheDocument();
  });

  it('control: when both flags are set (the stack never does that) only the unreachable line shows, never two', async () => {
    const held = withStatus(w.stack, { syncPaused: true, serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    await screen.findByText(SERVER_UNREACHABLE_TEXT);
    expect(screen.queryByText(SYNC_PAUSED_TEXT)).toBeNull();
  });

  it('control: when both flags are set and the device is offline, neither line shows (the chip speaks)', async () => {
    const held = withStatus(w.stack, { syncPaused: true, serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(false) });
    await screen.findByText('Offline');
    expect(screen.queryByText(SYNC_PAUSED_TEXT)).toBeNull();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
  });

  it('goes away when the stack clears it', async () => {
    const held = withStatus(w.stack, { syncPaused: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    await screen.findByText(SYNC_PAUSED_TEXT);
    act(() => {
      held.status.patch({ syncPaused: false });
    });
    await waitFor(() => expect(screen.queryByText(SYNC_PAUSED_TEXT)).toBeNull());
  });
});

describe('a real revocation wins over both grey lines', () => {
  it('the sign-in line shows and the grey lines do not', async () => {
    const held = withStatus(w.stack, { auth: true, serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
    const paused = withStatus(w.stack, { auth: true, syncPaused: true });
    cleanup();
    renderList(paused.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByText(SYNC_PAUSED_TEXT)).toBeNull();
  });

  it('control: the sign-in line alone shows with no grey line', async () => {
    const held = withStatus(w.stack, { auth: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
    expect(screen.queryByText(SYNC_PAUSED_TEXT)).toBeNull();
  });
});

describe('the grey line is a live region that is always in the page', () => {
  it('exists, empty, before anything is wrong, and the same element holds the text afterwards', async () => {
    const held = withStatus(w.stack, {});
    renderList(held.stack, { network: fakeNetwork(true) });
    await screen.findByTestId('row-a');
    const region = line();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toBeEmptyDOMElement();
    expect(region.className).toContain('sr-only');
    act(() => {
      held.status.patch({ serverUnreachable: true });
    });
    await waitFor(() => expect(line()).toHaveTextContent(SERVER_UNREACHABLE_TEXT));
    expect(line()).toBe(region);
    expect(region.className).not.toContain('sr-only');
    act(() => {
      held.status.patch({ serverUnreachable: false, syncPaused: true });
    });
    await waitFor(() => expect(line()).toHaveTextContent(SYNC_PAUSED_TEXT));
    expect(line()).toBe(region);
  });
});

describe('the Locked screen never shows these lines', () => {
  it('does not use the strip or read the stack status (control: the work list does)', () => {
    const read = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8');
    expect(read('Locked.tsx')).not.toMatch(/StatusStrip|StackStatus|serverUnreachable|syncPaused/);
    expect(read('WorkList.tsx')).toMatch(/StatusStrip/);
  });
});
