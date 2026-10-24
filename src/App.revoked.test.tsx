// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSignedInWorld, rowCounts, seedLocalData, type World } from './app/test-support/world';
import { setRevoked } from './offline/lock-state';
import { fakeScheduler } from './offline/test-support/fakes';

configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);

const WORK_HEADING = 'Work list coming in a later task';
const REVOKED_HEADING = 'This device can no longer upload';
const DATA_TABLES = ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package'];

async function dataRows(world: World): Promise<number[]> {
  const counts = await rowCounts(world.db);
  return DATA_TABLES.map((table) => counts[table] ?? -1);
}

async function revokedMarks(world: World): Promise<number> {
  return (await world.db.query("SELECT 1 FROM device_state WHERE key = 'locked_reason'")).length;
}

function sessionOf(userId: string): () => Response {
  return () => new Response(JSON.stringify({ success: true, data: { userId, tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function openRevoked(): Promise<World> {
  const world = await createSignedInWorld();
  await seedLocalData(world.db);
  await world.files.write('/p', new Uint8Array([1]));
  await setRevoked(world.db);
  render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
  return world;
}

describe('a revoked device signs in again', () => {
  it('the same person signs in again: the work screen, the revocation cleared, every data row kept', async () => {
    const world = await openRevoked();
    const before = await dataRows(world);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: WORK_HEADING })).toBeInTheDocument();
    expect(await dataRows(world)).toEqual(before);
    expect(await revokedMarks(world)).toBe(0);
  });

  it('control: a different person is refused, the lock stays, and Back returns to it with the data kept', async () => {
    const world = await openRevoked();
    const before = await dataRows(world);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    world.server.queue('/api/client/session', sessionOf('someone-else'));
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
    expect(await revokedMarks(world)).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: REVOKED_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
    expect(await dataRows(world)).toEqual(before);
    expect(await revokedMarks(world)).toBe(1);
  });

  it('Back without signing in returns to the lock screen, never to the work screen', async () => {
    await openRevoked();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: REVOKED_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
  });

  it('control: the sign-in screen after Clear local data has no Back', async () => {
    await openRevoked();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });
});

describe('Back from the sign-in screen when the stored identity cannot be used', () => {
  async function openSignInWithBack(): Promise<{ world: World; user: ReturnType<typeof userEvent.setup> }> {
    const world = await openRevoked();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await screen.findByRole('button', { name: 'Back' });
    return { world, user };
  }

  it('an identity that is gone: Back leaves the dead end for a sign-in screen without Back, and reveals no data', async () => {
    const { world, user } = await openSignInWithBack();
    await world.db.run("DELETE FROM device_state WHERE key = 'user_id'");
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
  });

  it('an identity read that throws: the lock screen with no unhandled rejection', async () => {
    const { world, user } = await openSignInWithBack();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    const realQuery = world.db.query.bind(world.db);
    const spy = vi.spyOn(world.db, 'query').mockImplementation((sql, params) => (sql.includes("'user_id'") ? Promise.reject(new Error('read failed')) : realQuery(sql, params)));
    try {
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
      spy.mockRestore();
    }
  });
});
