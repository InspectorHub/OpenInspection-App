// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFieldDataSource, useFieldSlots, type EditorData, type FieldDataSource } from '@inspectorhub/field-ui';
import type { EditorEvent, OfflineStack } from '../app/offline-stack';
import { createSignedInWorld, type World } from '../app/test-support/world';
import { createStackWorld, type StackWorld } from '../app/test-support/stack-world';
import { createEditorRegistry } from '../field/editor-registry';
import { MESSAGES } from '../field/messages';
import { seedPackage } from '../field/test-support/seed-package';
import { INSPECTION } from '../media/test-support/fakes';
import type { Network } from '../platform/network';
import { backRegistry, pressBack } from './back-button';
import { EditorScreen, READ_ONLY_NOTICE } from './EditorScreen';

const layers = vi.hoisted(() => ({ open: false }));
let renderedSource: FieldDataSource | null = null;

// The real editor needs a canvas and a layout engine; what this screen owns is what surrounds it.
vi.mock('@inspectorhub/field-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inspectorhub/field-ui')>();
  return {
    ...actual,
    escapeWillBeHandled: () => layers.open || actual.escapeWillBeHandled(),
    FieldEditor: ({ data, readOnly }: { data: EditorData; readOnly?: boolean }) => {
      const source = useFieldDataSource();
      renderedSource = source;
      const slots = useFieldSlots();
      return (
        <div>
          <p data-testid="address">{String(data.inspection.propertyAddress)}</p>
          <p data-testid="platform">{source.platform}</p>
          <p data-testid="read-only">{String(readOnly)}</p>
          <p data-testid="human-check">{slots.humanCheck ?? 'unset'}</p>
          <button type="button" onClick={() => source.exit()}>
            leave
          </button>
          <button type="button" onClick={() => source.reload()}>
            reload
          </button>
          <button type="button" onClick={() => void source.execute(data.inspection.id, { type: 'set-cover', photoId: 'p' } as never).then((r) => source.notify(r.ok ? 'done' : (r.error ?? 'refused'), 'info'))}>
            write
          </button>
        </div>
      );
    },
  };
});

const network: Network = { online: () => Promise.resolve(true), onChange: () => () => undefined };

let stackWorld: StackWorld;
let world: World;
let stack: OfflineStack;

beforeEach(async () => {
  layers.open = false;
  renderedSource = null;
  stackWorld = await createStackWorld();
  world = await createSignedInWorld();
  stack = stackWorld.make();
  await seedPackage(stackWorld.replay.db, INSPECTION);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(over: { stack?: OfflineStack; inspectionId?: string; onExit?: () => void; registry?: ReturnType<typeof createEditorRegistry>; network?: Network | null } = {}): ReactNode {
  return (
    <EditorScreen services={world.services} stack={over.stack ?? stack} origin={world.server.origin} inspectionId={over.inspectionId ?? INSPECTION} onExit={over.onExit ?? vi.fn()} {...(over.network === null ? {} : { network: over.network ?? network })} {...(over.registry === undefined ? {} : { registry: over.registry })} />
  );
}

const press = (exitApp: () => void): void => pressBack(backRegistry, { exitApp, escapeTarget: new EventTarget() });

function currentSource(): FieldDataSource {
  if (renderedSource === null) throw new Error('The editor has not opened');
  return renderedSource;
}

describe('the editor screen link state', () => {
  it('uses the supplied adapter for reads and changes, ignores browser state, and unsubscribes on unmount', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const listeners = new Set<(online: boolean) => void>();
    const supplied: Network = {
      online: vi.fn(() => Promise.resolve(false)),
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const view = render(mount({ network: supplied }));
    await screen.findByTestId('address');
    expect(supplied.online).toHaveBeenCalledTimes(1);
    expect(currentSource().isOnline()).toBe(false);
    expect(listeners.size).toBe(1);
    const seen: boolean[] = [];
    currentSource().onOnlineChange((online) => seen.push(online));
    act(() => window.dispatchEvent(new Event('online')));
    expect(currentSource().isOnline()).toBe(false);
    act(() => listeners.forEach((listener) => listener(true)));
    expect(currentSource().isOnline()).toBe(true);
    expect(seen).toEqual([true]);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it.each([true, false])('without an adapter, starts with navigator.onLine=%s', async (online) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
    render(mount({ network: null }));
    await screen.findByTestId('address');
    expect(currentSource().isOnline()).toBe(online);
  });

  it('without an adapter, follows browser link changes and disposes both browser listeners', async () => {
    const link = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(mount({ network: null }));
    await screen.findByTestId('address');
    const source = currentSource();
    const seen: boolean[] = [];
    source.onOnlineChange((online) => seen.push(online));
    const stopped: boolean[] = [];
    const stop = source.onOnlineChange((online) => stopped.push(online));
    stop();
    link.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    expect(source.isOnline()).toBe(true);
    link.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline')));
    expect(source.isOnline()).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(stopped).toEqual([]);
    const browserListeners = add.mock.calls.filter(([event]) => event === 'online' || event === 'offline');
    expect(browserListeners.map(([event]) => event).sort()).toEqual(['offline', 'online']);
    view.unmount();
    for (const [event, listener] of browserListeners) expect(remove).toHaveBeenCalledWith(event, listener);
    link.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    expect(source.isOnline()).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});

describe('the editor screen', () => {
  it('opens the cached inspection in the editor, for android, with the human check opted out explicitly', async () => {
    render(mount());
    expect(await screen.findByTestId('address')).toHaveTextContent('1 Main St');
    expect(screen.getByTestId('platform')).toHaveTextContent('android');
    expect(screen.getByTestId('human-check')).toHaveTextContent('not-required');
  });

  it('exit() returns to the work list, once', async () => {
    const onExit = vi.fn();
    render(mount({ onExit }));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'leave' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('the back key: an open layer takes the press; with none open it leaves for the list; the app is never left from here', async () => {
    const onExit = vi.fn();
    const exitApp = vi.fn();
    render(mount({ onExit }));
    await screen.findByTestId('address');
    layers.open = true;
    press(exitApp);
    expect(onExit).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
    layers.open = false;
    press(exitApp);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('control: with no layer in the real registry the real escapeWillBeHandled is false, so the press leaves', async () => {
    const { escapeWillBeHandled } = await vi.importActual<typeof import('@inspectorhub/field-ui')>('@inspectorhub/field-ui');
    expect(escapeWillBeHandled()).toBe(false);
  });

  it('the back key also leaves from the failure page, and stops answering once the screen is gone', async () => {
    const onExit = vi.fn();
    const exitApp = vi.fn();
    const view = render(mount({ onExit, inspectionId: 'insp-missing' }));
    await screen.findByRole('alert');
    press(exitApp);
    expect(onExit).toHaveBeenCalledTimes(1);
    view.unmount();
    press(exitApp);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('an inspection that was never downloaded shows its reason and a way back, not an empty editor', async () => {
    const onExit = vi.fn();
    render(mount({ inspectionId: 'insp-missing', onExit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.unavailable);
    expect(screen.queryByTestId('address')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to work list' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('is open in the registry while mounted and released after', async () => {
    const registry = createEditorRegistry();
    const view = render(mount({ registry }));
    await screen.findByTestId('address');
    expect(registry.isOpenInEditor(INSPECTION)).toBe(true);
    view.unmount();
    expect(registry.isOpenInEditor(INSPECTION)).toBe(false);
  });

  it('leaves when the stack removes or quarantines the inspection it shows, and not for another one or for an unquarantine', async () => {
    let listener: ((event: EditorEvent) => void) | null = null;
    const watched: OfflineStack = {
      ...stack,
      onEditorEvent: (l) => {
        listener = l;
        return () => undefined;
      },
    };
    const onExit = vi.fn();
    render(mount({ stack: watched, onExit }));
    await screen.findByTestId('address');
    const emit = (event: EditorEvent): void => act(() => listener?.(event));
    emit({ kind: 'purging', inspectionId: 'other' });
    emit({ kind: 'unquarantined', inspectionId: INSPECTION });
    expect(onExit).not.toHaveBeenCalled();
    emit({ kind: 'quarantined', inspectionId: INSPECTION });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('reads the inspection again when the editor asks for a reload', async () => {
    render(mount());
    await screen.findByTestId('address');
    await stackWorld.replay.db.run("UPDATE resource_cache SET body = REPLACE(body, '1 Main St', '2 Oak Ave') WHERE key = ?", [`/api/inspections/${INSPECTION}`]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'reload' }));
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('2 Oak Ave'));
  });

  it('shows what the editor says in a short-lived message', async () => {
    render(mount());
    await userEvent.setup().click(await screen.findByRole('button', { name: 'write' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});

describe('the editor screen while a required update turns editing off', () => {
  it('says so, still shows the inspection, and refuses the write', async () => {
    world.services.clientState.noteUpgrade(world.server.origin, 'required');
    render(mount());
    expect(await screen.findByTestId('address')).toBeInTheDocument();
    expect(screen.getByText(READ_ONLY_NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId('read-only')).toHaveTextContent('true');
    await userEvent.setup().click(screen.getByRole('button', { name: 'write' }));
    await waitFor(() => expect(screen.getAllByText(MESSAGES.editingOff).length).toBeGreaterThan(0));
  });

  it('control: with no update required there is no such notice', async () => {
    render(mount());
    await screen.findByTestId('address');
    expect(screen.queryByText(READ_ONLY_NOTICE)).toBeNull();
    expect(screen.getByTestId('read-only')).toHaveTextContent('false');
  });
});
