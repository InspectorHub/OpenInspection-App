// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld, rowCounts, seedLocalData, type World } from '../app/test-support/world';
import { AuthError, type IdentityMismatch } from '../auth/errors';
import { saveIdentity, writeDeviceState } from '../auth/server-config';
import { countAtRisk } from '../offline/at-risk';
import { atRiskLines } from './ClearLocalDataControl';
import { SignIn } from './SignIn';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const ORIGIN = 'https://new.example.test';
const STORED_ORIGIN = 'https://old.example.test';
const OTHER_COMPANY: IdentityMismatch = { sameCompany: false, storedRole: 'owner', newRole: 'inspector' };
const SAME_COMPANY: IdentityMismatch = { sameCompany: true, storedRole: 'inspector', newRole: 'manager' };

async function mismatchScreen(mismatch: IdentityMismatch, options: { unsent: boolean }) {
  const world: World = await createWorld();
  await saveIdentity(world.db, { userId: 'u1', tenantId: 't1', role: mismatch.storedRole });
  await writeDeviceState(world.db, 'identity_origin', STORED_ORIGIN);
  if (options.unsent) {
    await seedLocalData(world.db);
    // The media row points at this file; a clear removes it, as on a real device.
    await world.files.write('/p', new Uint8Array([1]));
  }
  vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new AuthError('identity_mismatch', undefined, mismatch));
  const onWiping = vi.fn<(wiping: boolean) => void>();
  render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} onWiping={onWiping} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  const panel = await screen.findByRole('alert');
  return { world, user, panel, onWiping };
}

describe('SignIn when the account is not the one whose data is on the device', () => {
  it('names the two servers, the company situation and both roles, and says nothing was changed', async () => {
    const { panel } = await mismatchScreen(OTHER_COMPANY, { unsent: false });
    expect(panel).toHaveTextContent('This device holds data for a different account.');
    expect(panel).toHaveTextContent(STORED_ORIGIN);
    expect(panel).toHaveTextContent(ORIGIN);
    expect(panel).toHaveTextContent(/different company/i);
    expect(panel).toHaveTextContent('owner');
    expect(panel).toHaveTextContent('inspector');
    expect(panel).toHaveTextContent(/nothing .* (changed|deleted)/i);
  });

  it('a different person in the same company says so, and a matching server is not called a different one', async () => {
    const world = await createWorld();
    await saveIdentity(world.db, { userId: 'u1', tenantId: 't1', role: 'inspector' });
    await writeDeviceState(world.db, 'identity_origin', ORIGIN);
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new AuthError('identity_mismatch', undefined, SAME_COMPANY));
    render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    const panel = await screen.findByRole('alert');
    expect(panel).toHaveTextContent(/same company/i);
    expect(panel).toHaveTextContent(/different (person|user)/i);
    expect(panel).not.toHaveTextContent(/different company/i);
    expect(panel).not.toHaveTextContent(/different server/i);
  });

  it('data saved before the server was recorded says so instead of guessing', async () => {
    const world = await createWorld();
    await saveIdentity(world.db, { userId: 'u1', tenantId: 't1', role: 'owner' });
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new AuthError('identity_mismatch', undefined, OTHER_COMPANY));
    render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('a server this version of the app did not record')).toBeInTheDocument();
  });

  it('lists what has not been uploaded, using the same count the clear dialog uses', async () => {
    const { world, panel } = await mismatchScreen(OTHER_COMPANY, { unsent: true });
    const lines = atRiskLines(await countAtRisk(world.db));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(within(panel).getByText(line)).toBeInTheDocument();
  });

  it('with nothing unsent it says everything has been uploaded', async () => {
    const { panel } = await mismatchScreen(OTHER_COMPANY, { unsent: false });
    expect(await within(panel).findByText('Everything on this device has been uploaded.')).toBeInTheDocument();
  });

  it('Keep this device\'s data dismisses the panel and leaves every row alone', async () => {
    const { world, user } = await mismatchScreen(OTHER_COMPANY, { unsent: true });
    const before = await rowCounts(world.db);
    await user.click(screen.getByRole('button', { name: "Keep this device's data" }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use a different server' })).toBeEnabled();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('removing with unsent work asks twice, then clears, and the panel gives way to a notice', async () => {
    const { world, user, onWiping } = await mismatchScreen(OTHER_COMPANY, { unsent: true });
    await user.click(screen.getByRole('button', { name: 'Remove this device\'s data and use this account' }));
    const first = await screen.findByRole('alertdialog');
    expect(await rowCounts(world.db)).toMatchObject({ ydoc_updates: 1 });
    await user.click(await within(first).findByRole('button', { name: 'Continue' }));
    const second = await screen.findByRole('alertdialog');
    expect(second).toHaveTextContent(/not uploaded/);
    // Nothing is removed before the second answer.
    expect(await rowCounts(world.db)).toMatchObject({ ydoc_updates: 1 });
    await user.click(within(second).getByRole('button', { name: 'Delete everything' }));
    await vi.waitFor(async () => expect(await rowCounts(world.db)).toMatchObject({ ydoc_updates: 0, media: 0, outbox: 0 }));
    expect(onWiping).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/data was removed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Keep this device's data" })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('removing when everything is uploaded is one question', async () => {
    const { user } = await mismatchScreen(OTHER_COMPANY, { unsent: false });
    await user.click(screen.getByRole('button', { name: 'Remove this device\'s data and use this account' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Clear local data' }));
    expect(await screen.findByText(/data was removed/i)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('control: the same error without the detail still shows the fixed one-line message and no recovery panel', async () => {
    const world = await createWorld();
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new AuthError('identity_mismatch'));
    render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This device holds data for a different account.');
    expect(screen.queryByRole('button', { name: "Keep this device's data" })).toBeNull();
  });
});
