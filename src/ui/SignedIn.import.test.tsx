// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import { confirmedBody, makePackage } from '../offline/test-support/import-fixtures';
import { backRegistry, pressBack } from './back-button';
import { importModule } from './import-loader';
import { IMPORT_UNAVAILABLE } from './ImportBoundary';
import { createListWorld } from './test-support/worklist-world';
import { SignedIn } from './SignedIn';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function mountOnSettings(onSignInAgain?: () => void) {
  const world = await createSignedInWorld();
  const list = await createListWorld();
  const view = render(
    <OfflineStackContext.Provider value={list.stack}>
      <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} {...(onSignInAgain === undefined ? {} : { onSignInAgain })} />
    </OfflineStackContext.Provider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  return { world, list, user, view };
}

describe('SignedIn: the import entry', () => {
  it('Settings opens the import screen; Back returns to Settings, not to the work list', async () => {
    const { user } = await mountOnSettings();
    await user.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Import a package' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Settings' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('a package goes to the server as the signed-in person: POST, Bearer token, zip content type, the exact bytes', async () => {
    const { world, user } = await mountOnSettings();
    const made = makePackage({ inspections: 2, photos: { 0: 1 }, updates: { 1: 1 } });
    world.server.queue('/api/client/import', () => json(200, confirmedBody(made.zip)));
    await user.click(screen.getByRole('button', { name: 'Import package' }));
    const input = await screen.findByTestId('import-file-input');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([made.zip.slice()], 'export.zip')] } });
    });
    await user.click(await screen.findByRole('button', { name: 'Review and import' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Import package' }));
    expect(await screen.findByText('All 2 inspections were imported.')).toBeVisible();

    const sent = world.server.requests.filter((r) => r.path === '/api/client/import');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.headers.authorization).toMatch(/^Bearer \S+/);
    expect(sent[0]?.headers['content-type']).toBe('application/zip');
    expect(sent[0]?.headers['x-client-platform']).toBeDefined();
    expect(sent[0]?.bytes).toEqual(made.zip);
  });

  it('control: without confirming, nothing reaches the import route', async () => {
    const { world, user } = await mountOnSettings();
    await user.click(screen.getByRole('button', { name: 'Import package' }));
    await act(async () => {
      fireEvent.change(await screen.findByTestId('import-file-input'), { target: { files: [new File([makePackage({ inspections: 1 }).zip.slice()], 'export.zip')] } });
    });
    await screen.findByRole('button', { name: 'Review and import' });
    expect(world.server.count('/api/client/import')).toBe(0);
  });
});

describe('SignedIn: the import screen is a chunk of its own', () => {
  it('while the chunk loads the screen says so and the Back key is used up; when it arrives the import opens', async () => {
    const real = importModule.load;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    importModule.load = async () => {
      await gate;
      return real();
    };
    try {
      const { user } = await mountOnSettings();
      await user.click(screen.getByRole('button', { name: 'Import package' }));
      expect(screen.getByRole('status')).toHaveTextContent('Opening the import');
      const exit = vi.fn();
      act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
      expect(exit).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).toHaveTextContent('Opening the import');
      expect(screen.queryByRole('heading', { level: 1, name: 'Settings' })).toBeNull();
      await act(async () => arrive());
      expect(await screen.findByRole('heading', { level: 1, name: 'Import a package' })).toBeInTheDocument();
    } finally {
      importModule.load = real;
    }
  });

  it('a chunk that cannot be loaded shows a way back to Settings, and a later open loads it again', async () => {
    const real = importModule.load;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    importModule.load = () => Promise.reject(new Error('chunk missing'));
    try {
      const { user } = await mountOnSettings();
      await user.click(screen.getByRole('button', { name: 'Import package' }));
      expect(await screen.findByText(IMPORT_UNAVAILABLE)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back to settings' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
      importModule.load = real;
      await user.click(screen.getByRole('button', { name: 'Import package' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Import a package' })).toBeInTheDocument();
    } finally {
      importModule.load = real;
      quiet.mockRestore();
    }
  });
});

describe('SignedIn: the sign-in ends an import', () => {
  it('the result offers "Sign in again", and it reaches the host\'s sign-in path through the lazy chunk', async () => {
    const signIn = vi.fn();
    const { world, user } = await mountOnSettings(signIn);
    world.server.queue('/api/client/import', () => json(401, { error: { code: 'UNAUTHORIZED' } }));
    world.server.queue('/api/client/import', () => json(401, { error: { code: 'UNAUTHORIZED' } }));
    await user.click(screen.getByRole('button', { name: 'Import package' }));
    await act(async () => {
      fireEvent.change(await screen.findByTestId('import-file-input'), { target: { files: [new File([makePackage({ inspections: 2 }).zip.slice()], 'export.zip')] } });
    });
    await user.click(await screen.findByRole('button', { name: 'Review and import' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Import package' }));
    const again = await screen.findByRole('button', { name: 'Sign in again' });
    expect(signIn).not.toHaveBeenCalled();
    await user.click(again);
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});

describe('SignedIn: the session ends while the import is open', () => {
  it('Settings is shown meanwhile, and the import does not come back by itself when the session returns', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    const tree = (stack: typeof list.stack | null) => (
      <OfflineStackContext.Provider value={stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>
    );
    const view = render(tree(list.stack));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Import package' }));
    await screen.findByRole('heading', { level: 1, name: 'Import a package' });
    view.rerender(tree(null));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument());
    view.rerender(tree(list.stack));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Import a package' })).toBeNull();
  });
});
