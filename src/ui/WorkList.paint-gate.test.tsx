// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_PAINT_CAP_MS } from '../app/offline-stack';
import { createStackWorld } from '../app/test-support/stack-world';
import { renderList } from './test-support/worklist-render';
import { at, seedPkg } from './test-support/worklist-world';

afterEach(cleanup);

describe('the work list releases the stack start sequence when it has painted', () => {
  it('nothing is requested while the list is not on screen; once its first snapshot is shown the start sequence runs, without the cap', async () => {
    const world = await createStackWorld();
    const stack = world.make({ deferLaunchUntilPainted: true });
    await seedPkg(world.replay.db, { id: 'a', scheduledAt: at(0) });
    stack.start();
    for (let i = 0; i < 300; i += 1) await Promise.resolve();
    expect(world.pkg.requests).toEqual([]);

    renderList(stack);
    await screen.findByTestId('row-a');
    await stack.settled();
    await stack.idle();
    expect(world.pkg.requests.length).toBeGreaterThan(0);
    expect(world.replay.timers.requested()).toContain(LAUNCH_PAINT_CAP_MS);
    expect(world.replay.timers.delays()).not.toContain(LAUNCH_PAINT_CAP_MS);
    await stack.stop();
  });
});
