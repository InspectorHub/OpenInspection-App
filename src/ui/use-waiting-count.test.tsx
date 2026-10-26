// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createListWorld, seedMedia, seedPkg } from './test-support/worklist-world';
import { useWaitingCount } from './use-waiting-count';
import type { Db } from '../platform/db';
import type { TimerPort } from '../collab/timers';

afterEach(cleanup);

function Probe({ db, timers }: { db: Db; timers: TimerPort }) {
  const count = useWaitingCount(db, { timers });
  return <p data-testid="count">{count === null ? 'unknown' : String(count)}</p>;
}

describe('useWaitingCount', () => {
  it('reads once at mount, then again each time its timer fires, and follows the database', async () => {
    const { db } = await createListWorld();
    const timers = createManualTimers();
    await seedPkg(db, { id: 'a' });
    render(<Probe db={db} timers={timers} />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    await seedMedia(db, 'm1', 'a', 'pending');
    await waitFor(() => expect(timers.pending()).toBe(1));
    await act(async () => timers.fireNext());
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
  });

  it('keeps one timer at a time and none after unmount', async () => {
    const { db } = await createListWorld();
    const timers = createManualTimers();
    const view = render(<Probe db={db} timers={timers} />);
    await waitFor(() => expect(timers.pending()).toBe(1));
    view.unmount();
    expect(timers.pending()).toBe(0);
  });

  it('does not read after unmount even if a read was in flight', async () => {
    const { db } = await createListWorld();
    const timers = createManualTimers();
    const query = vi.spyOn(db, 'query');
    const view = render(<Probe db={db} timers={timers} />);
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const calls = query.mock.calls.length;
    expect(timers.pending()).toBe(0);
    expect(query.mock.calls.length).toBe(calls);
  });

  it('a failed read keeps the last number and keeps going', async () => {
    const { db } = await createListWorld();
    const timers = createManualTimers();
    await seedMedia(db, 'm1', 'a', 'pending');
    render(<Probe db={db} timers={timers} />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
    const query = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('busy'));
    await waitFor(() => expect(timers.pending()).toBe(1));
    await act(async () => timers.fireNext());
    await waitFor(() => expect(query).toHaveBeenCalled());
    await waitFor(() => expect(timers.pending()).toBe(1));
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });
});
