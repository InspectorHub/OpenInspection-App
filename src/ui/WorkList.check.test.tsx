// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineStack } from '../app/offline-stack';
import { createManualTimers, type ManualTimers } from '../collab/test-support/manual-timers';
import type { ReconcileOutcome } from '../offline/reconciler';
import { fakeNetwork } from '../offline/test-support/replay-world';
import { reconcileOutcome, renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, NOW, seedPkg, type ListWorld } from './test-support/worklist-world';
import { CHECK_NOTE_MS } from './worklist/ReconcileStatus';

let w: ListWorld;
let timers: ManualTimers;

beforeEach(async () => {
  w = await createListWorld();
  timers = createManualTimers();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
});
afterEach(cleanup);

interface Held {
  stack: OfflineStack;
  trigger: ReturnType<typeof vi.fn>;
  setOutcome(next: Partial<ReconcileOutcome>): void;
  /** Tells the work list the stack moved, as the real stack does after a flow. */
  announce(): void;
}

function held(initial: Partial<ReconcileOutcome> = {}): Held {
  let current = reconcileOutcome(initial);
  const trigger = vi.fn();
  const base: OfflineStack = {
    ...w.stack,
    reconciler: {
      trigger,
      onNeedsReconcile: () => undefined,
      get last() {
        return current;
      },
    },
  };
  const { stack, status } = withStatus(base);
  let n = 0;
  return {
    stack,
    trigger,
    setOutcome: (next) => {
      current = reconcileOutcome({ ...initial, ...next });
    },
    announce: () => {
      n += 1;
      act(() => {
        status.patch({ reconcile: n % 2 === 0 ? 'done' : 'busy' });
      });
    },
  };
}

const checkNow = () => screen.getByRole('button', { name: 'Check now' });
const NOTE = /Check requested\.|Check could not run \(offline or locked\)|Could not start the check/;

async function open(h: Held, props: Parameters<typeof renderList>[1] = {}) {
  renderList(h.stack, { timers, ...props });
  await screen.findByTestId('row-a');
  return userEvent.setup();
}

describe('Check now: the note about the request does not outlive the request', () => {
  it('says the check was requested, and the note ends after a bounded time when no outcome ever arrives', async () => {
    const h = held();
    const user = await open(h);
    await user.click(checkNow());
    expect(await screen.findByText('Check requested.')).toBeInTheDocument();
    expect(h.trigger).toHaveBeenCalledExactlyOnceWith('manual');
    expect(timers.delays()).toEqual([CHECK_NOTE_MS]);
    expect(CHECK_NOTE_MS).toBe(10_000);
    act(() => {
      timers.fireWithDelay(CHECK_NOTE_MS);
    });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('the note is cleared as soon as a new outcome arrives', async () => {
    const h = held({ at: NOW - 60_000 });
    const user = await open(h);
    await user.click(checkNow());
    expect(await screen.findByText('Check requested.')).toBeInTheDocument();
    h.setOutcome({ at: NOW });
    h.announce();
    expect(await screen.findByText('Checked this minute')).toBeInTheDocument();
    expect(screen.queryByText('Check requested.')).toBeNull();
  });

  it('a second request restarts the time instead of adding a second timer', async () => {
    const h = held();
    const user = await open(h);
    await user.click(checkNow());
    await screen.findByText('Check requested.');
    await user.click(checkNow());
    expect(timers.pending()).toBe(1);
    expect(h.trigger).toHaveBeenCalledTimes(2);
  });

  it('offline: the request is made but the note says it could not run', async () => {
    const h = held();
    const user = await open(h, { network: fakeNetwork(false) });
    await user.click(checkNow());
    expect(await screen.findByText('Check could not run (offline or locked)')).toBeInTheDocument();
    expect(screen.queryByText('Check requested.')).toBeNull();
    act(() => {
      timers.fireWithDelay(CHECK_NOTE_MS);
    });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('before the first flow has finished the reconciler ignores the request, and the note says so', async () => {
    const h = held({ status: 'never', at: null });
    const user = await open(h);
    await user.click(checkNow());
    expect(await screen.findByText('Check could not run (offline or locked)')).toBeInTheDocument();
  });

  it('control: online with a finished first flow it says requested, not ignored', async () => {
    const h = held({ status: 'done' });
    const user = await open(h, { network: fakeNetwork(true) });
    await user.click(checkNow());
    expect(await screen.findByText('Check requested.')).toBeInTheDocument();
    expect(screen.queryByText('Check could not run (offline or locked)')).toBeNull();
  });

  it('the note is read by assistive technology (polite live region) and the timer is cancelled when the screen goes', async () => {
    const h = held();
    const user = await open(h);
    await user.click(checkNow());
    const note = await screen.findByText('Check requested.');
    expect(note).toHaveAttribute('aria-live', 'polite');
    cleanup();
    expect(timers.pending()).toBe(0);
    expect(within(document.body).queryByText(NOTE)).toBeNull();
  });
});
