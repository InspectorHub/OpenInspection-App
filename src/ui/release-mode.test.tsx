// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createWorld } from '../app/test-support/world';
import { AUTH_ERROR_MESSAGES } from '../auth/errors';
import { ServerSetup } from './ServerSetup';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const PLAIN_HTTP_LABEL = /plain http/i;
const LAN_ADDRESS = 'http://10.0.2.2:8787';

/** Both props are left at their defaults on purpose: only the build's own DEV flag may decide. */
async function renderSetup() {
  const world = await createWorld();
  render(<ServerSetup services={world.services} onConnected={vi.fn()} initialUrl="" />);
  return { world, user: userEvent.setup() };
}

describe('release build (DEV off)', () => {
  it('ServerSetup has no plain-http toggle even though its props ask for the switch', async () => {
    vi.stubEnv('DEV', false);
    await renderSetup();
    expect(screen.queryByLabelText(PLAIN_HTTP_LABEL)).toBeNull();
  });

  it('ServerSetup refuses a plain http address to another host', async () => {
    vi.stubEnv('DEV', false);
    const { user } = await renderSetup();
    await user.type(screen.getByLabelText('Server address'), LAN_ADDRESS);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.invalid_server_url);
    expect(screen.queryByTestId('canonical-origin')).toBeNull();
  });

  it('boot ignores allowInsecureHttp: a stored plain-http address sends the user to setup', async () => {
    vi.stubEnv('DEV', false);
    const world = await createWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', ?)", [LAN_ADDRESS]);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp />);
    expect(await screen.findByRole('heading', { name: 'Choose your server' })).toBeInTheDocument();
    expect(screen.queryByLabelText(PLAIN_HTTP_LABEL)).toBeNull();
  });
});

describe('development build (DEV on), the control', () => {
  it('ServerSetup offers the toggle, and with it on accepts the plain http address', async () => {
    vi.stubEnv('DEV', true);
    const { user } = await renderSetup();
    await user.type(screen.getByLabelText('Server address'), LAN_ADDRESS);
    await user.click(screen.getByLabelText(PLAIN_HTTP_LABEL));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('canonical-origin')).toHaveTextContent(LAN_ADDRESS);
  });

  it('boot honours allowInsecureHttp: the stored plain-http address is trusted', async () => {
    vi.stubEnv('DEV', true);
    const world = await createWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', ?)", [LAN_ADDRESS]);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('boot with allowInsecureHttp off still refuses it', async () => {
    vi.stubEnv('DEV', true);
    const world = await createWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', ?)", [LAN_ADDRESS]);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} />);
    expect(await screen.findByRole('heading', { name: 'Choose your server' })).toBeInTheDocument();
  });
});
