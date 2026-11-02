// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFieldDataSource, type EditorData, type FieldDataSource } from '@inspectorhub/field-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createStackFactory } from './app/real-stack';
import { createSignedInWorld, restartOffline } from './app/test-support/world';
import { loadIdentity } from './auth/server-config';
import { seedPackage } from './field/test-support/seed-package';
import { createFakePlugin, INSPECTION } from './media/test-support/fakes';
import { fakeAppState, fakeScheduler } from './offline/test-support/fakes';
import { fakeNetwork } from './offline/test-support/replay-world';

let renderedSource: FieldDataSource | null = null;

// Keep the app, lazy editor screen and data source real; the canvas editor needs a layout engine.
vi.mock('@inspectorhub/field-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inspectorhub/field-ui')>();
  return {
    ...actual,
    FieldEditor: ({ data }: { data: EditorData }) => {
      renderedSource = useFieldDataSource();
      return <p>{String(data.inspection.propertyAddress)}</p>;
    },
  };
});

afterEach(() => {
  cleanup();
  renderedSource = null;
  vi.restoreAllMocks();
});

function currentSource(): FieldDataSource {
  if (renderedSource === null) throw new Error('The editor has not opened');
  return renderedSource;
}

describe('the app passes platform link state to the editor', () => {
  it('uses native state over browser state and delivers native changes through App and SignedIn', async () => {
    const browser = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const native = fakeNetwork(false);
    const world = await createSignedInWorld();
    const identity = await loadIdentity(world.db);
    if (identity === null) throw new Error('The fixture is not signed in');
    await seedPackage(world.db, INSPECTION, { owner: identity });
    const { services } = restartOffline(world);
    const offline = createStackFactory(
      {
        // Keep background sync offline while testing the editor's independent native connection.
        network: fakeNetwork(false),
        uploaderPlugin: createFakePlugin({ files: world.files }),
        socketFactory: () => ({ isOpen: () => false, send: () => undefined, close: () => undefined }),
      },
      { appState: fakeAppState() },
    );
    const view = render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={offline} network={native} />);
    const row = await screen.findByTestId(`row-${INSPECTION}`);
    const open = row.querySelector('button');
    if (open === null) throw new Error('The inspection has no open button');
    await userEvent.setup().click(open);
    await screen.findByText('1 Main St');

    const source = currentSource();
    expect(source.isOnline()).toBe(false);
    const seen: boolean[] = [];
    source.onOnlineChange((online) => seen.push(online));
    act(() => window.dispatchEvent(new Event('online')));
    expect(source.isOnline()).toBe(false);

    browser.mockReturnValue(false);
    act(() => native.set(true));
    expect(source.isOnline()).toBe(true);
    act(() => window.dispatchEvent(new Event('offline')));
    expect(source.isOnline()).toBe(true);
    act(() => native.set(false));
    expect(source.isOnline()).toBe(false);
    expect(seen).toEqual([true, false]);

    view.unmount();
    expect(native.listeners()).toBe(0);
  });
});
