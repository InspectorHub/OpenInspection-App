// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld, type World } from '../app/test-support/world';
import { AUTH_ERROR_MESSAGES } from '../auth/errors';
import { loadClientId } from '../auth/server-config';
import { NATIVE_LOGIN_HELP } from './messages';
import { DEFAULT_SERVER_URL, ServerSetup } from './ServerSetup';

afterEach(cleanup);

const HOSTILE = 'SERVER-TEXT-MUST-NOT-BE-SHOWN';

async function storedServerUrl(world: World): Promise<string | null> {
  const rows = await world.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'server_url'");
  return rows[0]?.value ?? null;
}

async function setup(options: { devHttpSwitch?: boolean; world?: World; initialUrl?: string } = {}) {
  const world = options.world ?? (await createWorld());
  const onConnected = vi.fn();
  const user = userEvent.setup();
  render(<ServerSetup services={world.services} onConnected={onConnected} devHttpSwitch={options.devHttpSwitch ?? false} initialUrl={options.initialUrl ?? ''} />);
  return { world, onConnected, user };
}

async function typeAddress(user: ReturnType<typeof userEvent.setup>, value: string): Promise<void> {
  const input = screen.getByLabelText('Server address');
  await user.clear(input);
  await user.type(input, value);
}

describe('ServerSetup address entry', () => {
  it('offers the hosted service address by default', async () => {
    const world = await createWorld();
    render(<ServerSetup services={world.services} onConnected={vi.fn()} devHttpSwitch={false} />);
    expect(screen.getByLabelText('Server address')).toHaveValue(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe('https://app.inspectorhub.io');
  });

  it('rejects a bad address with the fixed message and makes no network call', async () => {
    const { world, user } = await setup();
    await typeAddress(user, 'ftp://oi.example.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.invalid_server_url);
    expect(world.fetched).toEqual([]);
    expect(screen.queryByTestId('canonical-origin')).toBeNull();
  });

  it('control: a good address reaches the confirmation step, still without a network call', async () => {
    const { world, user } = await setup();
    await typeAddress(user, 'https://oi.example.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('canonical-origin')).toHaveTextContent('https://oi.example.test');
    expect(world.fetched).toEqual([]);
  });

  it('shows the canonical origin, not what was typed, before anything is registered', async () => {
    const { world, user } = await setup();
    await typeAddress(user, '  HTTPS://OI.Example.test:443/  ');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('canonical-origin')).toHaveTextContent(/^https:\/\/oi\.example\.test$/);
    expect(world.server.count('/oauth/register')).toBe(0);
  });

  it('a plain http address to another host is refused in a release build, which has no switch for it', async () => {
    const { world, user } = await setup({ devHttpSwitch: false });
    expect(screen.queryByLabelText(/plain http/i)).toBeNull();
    await typeAddress(user, 'http://10.0.2.2:8787');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.invalid_server_url);
    expect(world.fetched).toEqual([]);
  });

  it('control: a development build shows the switch and, once it is ticked, accepts that address', async () => {
    const { user } = await setup({ devHttpSwitch: true });
    await typeAddress(user, 'http://10.0.2.2:8787');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.invalid_server_url);
    await user.click(screen.getByLabelText(/plain http/i));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('canonical-origin')).toHaveTextContent('http://10.0.2.2:8787');
  });

  it('Change address returns to the entry field with the text kept', async () => {
    const { user } = await setup();
    await typeAddress(user, 'https://oi.example.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Change address' }));
    expect(screen.getByLabelText('Server address')).toHaveValue('https://oi.example.test');
  });
});

describe('ServerSetup connect', () => {
  async function toConfirm(world?: World) {
    const ctx = await setup({ world });
    await typeAddress(ctx.user, 'https://oi.example.test');
    await ctx.user.click(screen.getByRole('button', { name: 'Continue' }));
    return ctx;
  }

  it('control: a good server is checked, registered, remembered, and handed on', async () => {
    const { world, user, onConnected } = await toConfirm();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected).toHaveBeenCalledWith('https://oi.example.test', []);
    expect(world.server.count('/api/client/compat')).toBe(1);
    expect(world.server.count('/oauth/register')).toBe(1);
    expect(await storedServerUrl(world)).toBe('https://oi.example.test');
    expect(await loadClientId(world.db, 'https://oi.example.test')).not.toBeNull();
  });

  it('a failed compatibility check shows fixed text, never the server text, and stores nothing', async () => {
    const world = await createWorld();
    world.server.queue('/api/client/compat', () => new Response(HOSTILE, { status: 500 }));
    const { user, onConnected } = await toConfirm(world);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.server_response_invalid);
    expect(document.body.textContent).not.toContain(HOSTILE);
    expect(onConnected).not.toHaveBeenCalled();
    expect(world.server.count('/oauth/register')).toBe(0);
    expect(await storedServerUrl(world)).toBeNull();
    // Connect is offered again.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('an unreachable server shows the fixed unreachable message', async () => {
    const world = await createWorld({
      fetch: () => Promise.reject(new TypeError(HOSTILE)),
    });
    const { user } = await toConfirm(world);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.server_unreachable);
    expect(document.body.textContent).not.toContain(HOSTILE);
  });

  it('a server that answers compat but has native sign-in off explains it and is not remembered', async () => {
    const world = await createWorld({ server: { nativeEnabled: false } });
    const { user, onConnected } = await toConfirm(world);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.native_login_unavailable);
    expect(screen.getByText(NATIVE_LOGIN_HELP)).toBeInTheDocument();
    expect(world.server.count('/api/client/compat')).toBe(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(await storedServerUrl(world)).toBeNull();
  });

  it('a server with an older contract still connects, and the state is passed on to sign-in', async () => {
    const world = await createWorld({ server: { contractVersion: 0 } });
    const { user, onConnected } = await toConfirm(world);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith('https://oi.example.test', ['server_too_old']));
  });

  it('while connecting, Connect shows a working state without being dimmed, and Change address is plainly disabled', async () => {
    const world = await createWorld({ fetch: () => new Promise<Response>(() => undefined) });
    const { user } = await toConfirm(world);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const working = await screen.findByRole('button', { name: 'Connecting' });
    expect(working).toBeDisabled();
    expect(working).toHaveAttribute('aria-busy', 'true');
    expect(working.className).not.toMatch(/opacity/);
    expect(screen.getByRole('button', { name: 'Change address' })).toBeDisabled();
  });

  it('two taps on Connect in one frame check the server once', async () => {
    const { world, onConnected } = await toConfirm();
    const button = screen.getByRole('button', { name: 'Connect' });
    act(() => {
      button.click();
      button.click();
    });
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(world.server.count('/api/client/compat')).toBe(1);
    expect(world.server.count('/oauth/register')).toBe(1);
  });
});
