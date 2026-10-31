// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, seedMedia, seedPkg, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;
beforeEach(async () => {
  w = await createListWorld();
  await seedPkg(w.db, { id: 'a', scheduledAt: at(0) });
  await seedMedia(w.db, 'm1', 'a', 'pending');
});
afterEach(cleanup);

describe('the work list follows the waiting count without an event', () => {
  it('drops the Waiting to upload badge when a photo becomes uploaded behind its back, on the next poll', async () => {
    const timers = createManualTimers();
    // pollMs is large so the list's own interval cannot be what refreshes it; only the shared waiting-count poll can.
    renderList(w.stack, { pollMs: 600_000, timers });
    expect(await screen.findByText('Waiting to upload: 1')).toBeInTheDocument();
    await w.db.run("UPDATE media SET state = 'uploaded' WHERE pending_id = 'm1'");
    await waitFor(() => expect(timers.pending()).toBeGreaterThan(0));
    await act(async () => timers.fireNext());
    await waitFor(() => expect(screen.queryByText('Waiting to upload: 1')).toBeNull());
  });

  it('control: with polling off (pollMs 0, the test default) nothing is scheduled and the list stays as read', async () => {
    const timers = createManualTimers();
    renderList(w.stack, { pollMs: 0, timers });
    expect(await screen.findByText('Waiting to upload: 1')).toBeInTheDocument();
    await w.db.run("UPDATE media SET state = 'uploaded' WHERE pending_id = 'm1'");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(timers.pending()).toBe(0);
    expect(screen.getByText('Waiting to upload: 1')).toBeInTheDocument();
  });
});
