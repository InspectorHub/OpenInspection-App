// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeldAuthSession, createWorld, type HeldAuthSession, type World } from '../app/test-support/world';
import { AUTH_ERROR_CODES, AUTH_ERROR_MESSAGES, AuthError } from '../auth/errors';
import type { SignInResult } from '../auth/pkce-login';
import { SignIn } from './SignIn';

afterEach(cleanup);

const HOSTILE = 'SERVER-TEXT-MUST-NOT-BE-SHOWN';
const ORIGIN = 'https://oi.example.test';

interface Rendered {
  world: World;
  held: HeldAuthSession | null;
  onSignedIn: ReturnType<typeof vi.fn<(result: SignInResult) => void>>;
  onChangeServer: ReturnType<typeof vi.fn<() => void>>;
}

async function renderSignIn(options: { relogin?: boolean; notices?: ('server_too_old' | 'update_required' | 'update_available')[]; held?: boolean } = {}): Promise<Rendered> {
  let held: HeldAuthSession | null = null;
  const world = await createWorld({
    authSession: options.held === false ? undefined : (server) => (held = createHeldAuthSession(server)),
  });
  const onSignedIn = vi.fn<(result: SignInResult) => void>();
  const onChangeServer = vi.fn<() => void>();
  render(<SignIn services={world.services} origin={ORIGIN} relogin={options.relogin ?? false} notices={options.notices ?? []} onSignedIn={onSignedIn} onChangeServer={onChangeServer} />);
  return { world, held, onSignedIn, onChangeServer };
}

describe('SignIn button', () => {
  it('two clicks in one frame start one login', async () => {
    const { world, held } = await renderSignIn();
    const signIn = vi.spyOn(world.services.flow, 'signIn');
    const button = screen.getByRole('button', { name: 'Sign in' });
    act(() => {
      button.click();
      button.click();
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(held?.opened).toBe(1));
  });

  it('control: a click starts a login, and the page it opens is the engine authorize page for this origin', async () => {
    const { world, held } = await renderSignIn();
    const signIn = vi.spyOn(world.services.flow, 'signIn');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(signIn).toHaveBeenCalledWith(ORIGIN);
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    expect(world.server.count('/oauth/register')).toBe(1);
  });

  it('shows a busy state with a visible Cancel while the login is open', async () => {
    const { held } = await renderSignIn();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    const waiting = screen.getByRole('button', { name: 'Waiting for sign-in' });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveAttribute('aria-busy', 'true');
    // A busy control is not dimmed: dimming a primary button drops its text below 4.5:1 in the dark scheme.
    expect(waiting.className).not.toMatch(/opacity/);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('Cancel calls flow.cancel and returns to the idle button without an error', async () => {
    const { world, held, onSignedIn } = await renderSignIn();
    const cancel = vi.spyOn(world.services.flow, 'cancel');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('after a cancel the person can sign in again', async () => {
    const { held, onSignedIn } = await renderSignIn();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(2));
    await act(async () => {
      await held?.approve();
    });
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('hints at Cancel when the browser tab was dismissed, because that alone does not end the login', async () => {
    const { held } = await renderSignIn();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    expect(screen.queryByText(/page was closed/i)).toBeNull();
    act(() => held?.closeBrowser());
    expect(screen.getByText(/page was closed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('a completed login hands the identity on', async () => {
    const { held, onSignedIn } = await renderSignIn();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held?.opened).toBe(1));
    await act(async () => {
      await held?.approve();
    });
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    const result = onSignedIn.mock.calls[0]?.[0];
    expect(result?.origin).toBe(ORIGIN);
    expect(result?.session).toMatchObject({ role: 'inspector', tenantId: 'tenant-1' });
  });

  it('Use a different server is offered while idle', async () => {
    const { onChangeServer } = await renderSignIn();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use a different server' }));
    expect(onChangeServer).toHaveBeenCalledTimes(1);
  });
});

describe('SignIn errors', () => {
  const SHOWN = AUTH_ERROR_CODES.filter((code) => code !== 'sign_in_cancelled');

  it.each(SHOWN)('shows the fixed message for %s', async (code) => {
    const { world } = await renderSignIn();
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new AuthError(code));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES[code]);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('covers every code the sign-in layer defines', () => {
    expect(SHOWN.length + 1).toBe(AUTH_ERROR_CODES.length);
    expect(new Set(SHOWN.map((c) => AUTH_ERROR_MESSAGES[c])).size).toBe(SHOWN.length);
  });

  it('an error that is not an AuthError shows the generic message, never its own text', async () => {
    const { world } = await renderSignIn();
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new Error(HOSTILE));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.sign_in_failed);
    expect(document.body.textContent).not.toContain(HOSTILE);
  });

  it('an AuthError that somehow carries server text still shows only the fixed message', async () => {
    const { world } = await renderSignIn();
    const tainted = new AuthError('sign_in_denied');
    tainted.message = HOSTILE;
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(tainted);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.sign_in_denied);
    expect(document.body.textContent).not.toContain(HOSTILE);
  });

  it('a denied sign-in on the real flow shows the denied message', async () => {
    const { world } = await renderSignIn({ held: false });
    world.server.authorizeMode = 'deny';
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.sign_in_denied);
  });

  it('a clean start shows no error', async () => {
    await renderSignIn();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('SignIn variants', () => {
  it('the relogin variant says the session ended and that local data is kept', async () => {
    await renderSignIn({ relogin: true });
    expect(screen.getByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByText(/saved on this device are kept/i)).toBeInTheDocument();
  });

  it('control: the ordinary variant does not claim a session ended', async () => {
    await renderSignIn({ relogin: false });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/are kept/i)).toBeNull();
  });

  it('shows server-too-old and update states without blocking the button', async () => {
    await renderSignIn({ notices: ['server_too_old', 'update_available'] });
    expect(screen.getByText(/server is older than the app expects/i)).toBeInTheDocument();
    expect(screen.getByText(/newer version of the app is available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows the server being signed in to', async () => {
    await renderSignIn();
    expect(screen.getByTestId('server-origin')).toHaveTextContent(ORIGIN);
  });
});
