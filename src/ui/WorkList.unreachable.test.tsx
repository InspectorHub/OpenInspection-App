// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeNetwork } from '../offline/test-support/replay-world';
import { SERVER_UNREACHABLE_TEXT } from './worklist/copy';
import { renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, seedPkg, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
});
afterEach(cleanup);

const SIGN_IN = 'Sign in again to keep syncing';

describe('the server cannot be reached while the device has a network', () => {
  it('says so in plain words, keeps the chip meaning "device network", and does not ask for a sign-in', async () => {
    const held = withStatus(w.stack, { serverUnreachable: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SERVER_UNREACHABLE_TEXT)).toBeInTheDocument();
    expect(SERVER_UNREACHABLE_TEXT).toBe("The server can't be reached right now. Your work is saved on this device and will sync when it is back.");
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.queryByText(SIGN_IN)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('control: a real revocation still shows the sign-in-again line, and not the unreachable one', async () => {
    const held = withStatus(w.stack, { auth: true });
    renderList(held.stack, { network: fakeNetwork(true) });
    expect(await screen.findByText(SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_UNREACHABLE_TEXT)).toBeNull();
  });
});
