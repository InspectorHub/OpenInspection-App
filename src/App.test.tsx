// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createHeldAuthSession, createSignedInWorld, createWorld, restartOffline, rowCounts, seedLocalData, type HeldAuthSession } from './app/test-support/world';
import { SCHEMA_DRIFT_MESSAGE, SchemaDriftError, SchemaTooNewError } from './platform/schema';
import { refreshTokenKey } from './auth/server-config';

afterEach(cleanup);

describe('App first screen', () => {
  it('a fresh install opens on server setup', async () => {
    const world = await createWorld();
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} />);
    expect(await screen.findByRole('heading', { name: 'Choose your server' })).toBeInTheDocument();
  });

  it('opens as signed in, offline, from a stored token', async () => {
    const world = await createSignedInWorld();
    const { services, calls } = restartOffline(world);
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} />);
    expect(await screen.findByRole('heading', { name: 'Work list' })).toBeInTheDocument();
    expect(screen.getByTestId('identity-role')).toHaveTextContent('Inspector');
    expect(screen.queryByTestId('identity-tenant')).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Sign in/ })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a database from a newer app shows the blocking screen and says export is not available yet', async () => {
    render(<App open={() => Promise.reject(new SchemaTooNewError(9, 1))} allowInsecureHttp={false} />);
    expect(await screen.findByRole('heading', { name: 'This app is older than your data' })).toBeInTheDocument();
    expect(screen.getByText(/not available yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an outdated development database shows the clear-the-app-data screen, with no controls and no SQL', async () => {
    render(<App open={() => Promise.reject(new SchemaDriftError('outbox.next_at'))} allowInsecureHttp={false} />);
    expect(await screen.findByText(SCHEMA_DRIFT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('This development build has an outdated local database: clear the app data')).toBeInTheDocument();
    expect(screen.queryByText(/next_at|outbox|no such column/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('This app is older than your data')).toBeNull();
  });

  it('control: the blocking screen is not shown for an ordinary open', async () => {
    const world = await createWorld();
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} />);
    await screen.findByRole('heading', { name: 'Choose your server' });
    expect(screen.queryByText('This app is older than your data')).toBeNull();
  });

  it('opens the database once per launch even where React runs effects twice', async () => {
    const world = await createWorld();
    const open = vi.fn(() => Promise.resolve(world.services));
    render(
      <StrictMode>
        <App open={open} allowInsecureHttp={false} />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'Choose your server' });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('App callback routing', () => {
  it('binds the login flow to the callback router once opened and unbinds on unmount', async () => {
    const world = await createWorld();
    const unbind = vi.fn();
    const bind = vi.fn(() => unbind);
    const view = render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} callbacks={{ bind }} />);
    await screen.findByRole('heading', { name: 'Choose your server' });
    await waitFor(() => expect(bind).toHaveBeenCalledWith(world.services.flow));
    view.unmount();
    expect(unbind).toHaveBeenCalled();
  });
});

describe('App whole journey', () => {
  it('server setup, then sign in, then signed in, then signed out with local data kept', async () => {
    let held: HeldAuthSession | null = null;
    const world = await createWorld({ authSession: (server) => (held = createHeldAuthSession(server)) });
    await seedLocalData(world.db);
    const countsBefore = await rowCounts(world.db);
    const user = userEvent.setup();
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} />);

    const input = await screen.findByLabelText('Server address');
    await user.clear(input);
    await user.type(input, world.server.origin);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    await act(async () => {
      await held?.approve();
    });

    expect(await screen.findByRole('heading', { name: 'Work list' })).toBeInTheDocument();
    expect(screen.getByTestId('identity-role')).toHaveTextContent('Inspector');
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeUndefined();

    const countsAfter = await rowCounts(world.db);
    for (const table of ['ydoc_updates', 'resource_cache', 'media', 'outbox', 'work_package']) {
      expect(countsAfter[table]).toBe(countsBefore[table]);
      expect(countsAfter[table]).toBe(1);
    }
  });

  it('Use a different server returns to setup', async () => {
    const world = await createWorld();
    const user = userEvent.setup();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', ?)", [world.server.origin]);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} />);
    await user.click(await screen.findByRole('button', { name: 'Use a different server' }));
    expect(await screen.findByRole('heading', { name: 'Choose your server' })).toBeInTheDocument();
  });
});
