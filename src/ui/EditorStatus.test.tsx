// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../app/stack-store';
import type { StackStatus } from '../app/offline-stack';
import { createManualTimers } from '../collab/test-support/manual-timers';
import type { Network } from '../platform/network';
import { EditorStatus } from './EditorStatus';
import { COLLAB_ISSUE_CHIP_TEXT, EDITS_NOT_SAVED_TEXT, SERVER_UNREACHABLE_CHIP_TEXT, SYNC_PAUSED_TEXT } from './worklist/copy';
import { createListWorld, seedMedia } from './test-support/worklist-world';

afterEach(cleanup);

const CALM: StackStatus = { auth: false, serverUnreachable: false, syncPaused: false, upgrade: false, editsNotSaved: false, collabIssue: false, reconcile: 'never' };

/** A network port the test can flip, like the page's own online and offline events. */
function fakeNetwork(initial: boolean): Network & { set(online: boolean): void } {
  let value = initial;
  const listeners = new Set<(online: boolean) => void>();
  return {
    online: () => Promise.resolve(value),
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next) {
      value = next;
      for (const cb of [...listeners]) cb(next);
    },
  };
}

async function setup(online = true) {
  const { db } = await createListWorld();
  const status = createStore<StackStatus>(CALM);
  const network = fakeNetwork(online);
  const timers = createManualTimers();
  const view = render(<EditorStatus db={db} status={status} network={network} timers={timers} />);
  return { db, status, network, timers, view };
}

describe('EditorStatus', () => {
  it('renders nothing when the device is online, signed in and has nothing waiting', async () => {
    const { view, timers } = await setup(true);
    await waitFor(() => expect(timers.pending()).toBe(1)); // the first count has answered
    expect(view.container).toBeEmptyDOMElement();
  });

  it('says Offline when the device has no connection', async () => {
    await setup(false);
    expect(await screen.findByText('Offline')).toBeInTheDocument();
  });

  it('says how many things wait to upload when online', async () => {
    const { db } = await createListWorld();
    await seedMedia(db, 'm1', 'a', 'pending');
    await seedMedia(db, 'm2', 'a', 'failed');
    render(<EditorStatus db={db} status={createStore<StackStatus>(CALM)} network={fakeNetwork(true)} timers={createManualTimers()} />);
    expect(await screen.findByText('2 waiting on this device')).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });

  it('says Offline with the waiting number when both apply', async () => {
    const { db } = await createListWorld();
    await seedMedia(db, 'm1', 'a', 'pending');
    render(<EditorStatus db={db} status={createStore<StackStatus>(CALM)} network={fakeNetwork(false)} timers={createManualTimers()} />);
    expect(await screen.findByText('Offline · 1 waiting on this device')).toBeInTheDocument();
  });

  it('says Sign in again when the session needs it, and that wins over offline and waiting', async () => {
    const { db } = await createListWorld();
    await seedMedia(db, 'm1', 'a', 'pending');
    render(<EditorStatus db={db} status={createStore<StackStatus>({ ...CALM, auth: true })} network={fakeNetwork(false)} timers={createManualTimers()} />);
    expect(await screen.findByText('Sign in again')).toBeInTheDocument();
    expect(screen.queryByText(/offline|waiting/i)).toBeNull();
  });

  it.each([
    ['editsNotSaved', EDITS_NOT_SAVED_TEXT],
    ['upgrade', 'Update required'],
    ['syncPaused', SYNC_PAUSED_TEXT],
    ['serverUnreachable', SERVER_UNREACHABLE_CHIP_TEXT],
    ['collabIssue', COLLAB_ISSUE_CHIP_TEXT],
  ] as const)('shows the %s state with the work list wording', async (key, text) => {
    render(<EditorStatus db={(await createListWorld()).db} status={createStore<StackStatus>({ ...CALM, [key]: true })} network={fakeNetwork(true)} timers={createManualTimers()} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('puts edits not saved before update required, before sync paused, before sign in, before offline and the queue', async () => {
    const { db } = await createListWorld();
    await seedMedia(db, 'm1', 'a', 'pending');
    const status = createStore<StackStatus>({ ...CALM, editsNotSaved: true, upgrade: true, syncPaused: true, auth: true, serverUnreachable: true, collabIssue: true });
    const network = fakeNetwork(true);
    render(<EditorStatus db={db} status={status} network={network} timers={createManualTimers()} />);
    expect(await screen.findByText(EDITS_NOT_SAVED_TEXT)).toBeInTheDocument();
    for (const [patch, text] of [
      [{ editsNotSaved: false }, 'Update required'],
      [{ upgrade: false }, SYNC_PAUSED_TEXT],
      [{ syncPaused: false }, 'Sign in again'],
      [{ auth: false }, SERVER_UNREACHABLE_CHIP_TEXT],
      [{ serverUnreachable: false }, COLLAB_ISSUE_CHIP_TEXT],
      [{ collabIssue: false }, '1 waiting on this device'],
    ] as const) {
      act(() => status.patch(patch));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getAllByRole('status')).toHaveLength(1);
    }
  });

  it('offline wins over unreachable and collaboration trouble, which it makes redundant', async () => {
    const { db } = await createListWorld();
    render(<EditorStatus db={db} status={createStore<StackStatus>({ ...CALM, serverUnreachable: true, collabIssue: true })} network={fakeNetwork(false)} timers={createManualTimers()} />);
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.queryByText(SERVER_UNREACHABLE_CHIP_TEXT)).toBeNull();
    expect(screen.queryByText(COLLAB_ISSUE_CHIP_TEXT)).toBeNull();
  });

  it('the stronger states still win over unreachable', async () => {
    const { db } = await createListWorld();
    render(<EditorStatus db={db} status={createStore<StackStatus>({ ...CALM, auth: true, serverUnreachable: true })} network={fakeNetwork(true)} timers={createManualTimers()} />);
    expect(await screen.findByText('Sign in again')).toBeInTheDocument();
  });

  it('is information only: it offers no button or link', async () => {
    await setup(false);
    await screen.findByText('Offline');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('follows the connection live, in both directions', async () => {
    const { network, view } = await setup(true);
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    act(() => network.set(false));
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    act(() => network.set(true));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it('follows the session live', async () => {
    const { status, view } = await setup(true);
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    act(() => status.patch({ auth: true }));
    expect(await screen.findByText('Sign in again')).toBeInTheDocument();
    act(() => status.patch({ auth: false }));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it('follows the queue live, up and back down to nothing', async () => {
    const { db, timers, view } = await setup(true);
    await waitFor(() => expect(timers.pending()).toBe(1));
    await seedMedia(db, 'm1', 'a', 'pending');
    await act(async () => timers.fireNext());
    expect(await screen.findByText('1 waiting on this device')).toBeInTheDocument();
    await db.run("UPDATE media SET state = 'uploaded' WHERE pending_id = 'm1'");
    await waitFor(() => expect(timers.pending()).toBe(1));
    await act(async () => timers.fireNext());
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it('leaves no timer running after it unmounts', async () => {
    const { timers, view } = await setup(true);
    await waitFor(() => expect(timers.pending()).toBe(1));
    view.unmount();
    expect(timers.pending()).toBe(0);
  });
});
