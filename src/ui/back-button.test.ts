// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackRegistry, pressBack, registerBackButton, type BackButtonApp } from './back-button';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

/** A modal layer, as the escape layer behaves: it listens on the window and prevents the default when it closes. */
function modalLayer(closes = true): { calls: number; off: () => void } {
  const state = { calls: 0, off: () => undefined as void };
  const listener = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    state.calls += 1;
    if (closes) event.preventDefault();
  };
  window.addEventListener('keydown', listener);
  state.off = () => window.removeEventListener('keydown', listener);
  cleanups.push(state.off);
  return state;
}

function setup() {
  const registry = createBackRegistry();
  const exit = vi.fn<() => void>();
  const press = (): void => pressBack(registry, { exitApp: exit, escapeTarget: window });
  return { registry, exit, press };
}

describe('pressBack', () => {
  it('exits the app at the root: nothing registered, no modal (control for every test below)', () => {
    const { exit, press } = setup();
    press();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('tier 1: an open modal consumes the press, and nothing else runs', () => {
    const { registry, exit, press } = setup();
    const modal = modalLayer();
    const screen = vi.fn(() => true);
    registry.registerScreen(screen);
    registry.registerGuard(() => true);
    press();
    expect(modal.calls).toBe(1);
    expect(screen).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('tier 1 alone: a listener that sees the Escape but does not prevent it has not consumed the press', () => {
    const { exit, press } = setup();
    const modal = modalLayer(false);
    press();
    expect(modal.calls).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('tier 2 alone: the topmost screen handler consumes the press', () => {
    const { registry, exit, press } = setup();
    const lower = vi.fn(() => true);
    const upper = vi.fn(() => true);
    registry.registerScreen(lower);
    registry.registerScreen(upper);
    press();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('tier 2: a handler that does not consume lets the one below it answer', () => {
    const { registry, exit, press } = setup();
    const lower = vi.fn(() => true);
    const upper = vi.fn(() => false);
    registry.registerScreen(lower);
    registry.registerScreen(upper);
    press();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('tier 3 alone: a guard consumes the press that would have left the app', () => {
    const { registry, exit, press } = setup();
    const guard = vi.fn(() => true);
    registry.registerGuard(guard);
    press();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('tier 3 runs only after the screen handlers declined (a consuming screen handler keeps the guard quiet)', () => {
    const { registry, press } = setup();
    const guard = vi.fn(() => true);
    registry.registerGuard(guard);
    registry.registerScreen(() => true);
    press();
    expect(guard).not.toHaveBeenCalled();
    const second = setup();
    const secondGuard = vi.fn(() => true);
    second.registry.registerGuard(secondGuard);
    second.registry.registerScreen(() => false);
    second.press();
    expect(secondGuard).toHaveBeenCalledTimes(1);
  });

  it('tier 4: when every tier declines, the app exits exactly once', () => {
    const { registry, exit, press } = setup();
    registry.registerScreen(() => false);
    registry.registerGuard(() => false);
    modalLayer(false);
    press();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('runs the tiers in the order modal, screen, guard, exit', () => {
    const { registry, exit, press } = setup();
    const order: string[] = [];
    const listener = (event: KeyboardEvent): void => {
      order.push('modal');
      if (order.length === 1) event.preventDefault();
    };
    window.addEventListener('keydown', listener);
    cleanups.push(() => window.removeEventListener('keydown', listener));
    registry.registerScreen(() => {
      order.push('screen');
      return false;
    });
    registry.registerGuard(() => {
      order.push('guard');
      return false;
    });
    exit.mockImplementation(() => {
      order.push('exit');
    });
    press();
    expect(order).toEqual(['modal']);
    press();
    expect(order).toEqual(['modal', 'modal', 'screen', 'guard', 'exit']);
  });

  it('a handler that throws does not swallow the press: the next one answers, and with none left the app exits', () => {
    const { registry, exit, press } = setup();
    const lower = vi.fn(() => true);
    registry.registerScreen(lower);
    registry.registerScreen(() => {
      throw new Error('broken screen');
    });
    press();
    expect(lower).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    const only = setup();
    only.registry.registerScreen(() => {
      throw new Error('broken screen');
    });
    only.registry.registerGuard(() => {
      throw new Error('broken guard');
    });
    only.press();
    expect(only.exit).toHaveBeenCalledTimes(1);
  });

  it('a throwing exit does not escape the press', () => {
    const registry = createBackRegistry();
    expect(() =>
      pressBack(registry, {
        exitApp: () => {
          throw new Error('no plugin');
        },
        escapeTarget: window,
      }),
    ).not.toThrow();
  });
});

describe('several guards', () => {
  it('the most recently registered guard is asked first and, when it keeps the person in the app, the others are not asked', () => {
    const { registry, exit, press } = setup();
    const lower = vi.fn(() => true);
    const upper = vi.fn(() => true);
    registry.registerGuard(lower);
    registry.registerGuard(upper);
    press();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a guard that declines passes the press to the guard below it, and when all decline the app exits', () => {
    const { registry, exit, press } = setup();
    const order: string[] = [];
    registry.registerGuard(() => {
      order.push('lower');
      return false;
    });
    registry.registerGuard(() => {
      order.push('upper');
      return false;
    });
    press();
    expect(order).toEqual(['upper', 'lower']);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('registration', () => {
  it('unregistering removes the handler (no leak), and unregistering twice is harmless', () => {
    const { registry, exit, press } = setup();
    const handler = vi.fn(() => true);
    const off = registry.registerScreen(handler);
    expect(registry.size()).toBe(1);
    off();
    off();
    expect(registry.size()).toBe(0);
    press();
    expect(handler).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('the same function registered twice is two registrations: removing one leaves the other, and a stale remove removes nothing else', () => {
    const { registry, exit, press } = setup();
    const handler = vi.fn(() => true);
    const first = registry.registerScreen(handler);
    const second = registry.registerScreen(handler);
    expect(registry.size()).toBe(2);
    first();
    first();
    expect(registry.size()).toBe(1);
    press();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    second();
    expect(registry.size()).toBe(0);
  });

  it('guards and screen handlers are counted and removed separately', () => {
    const { registry } = setup();
    const offScreen = registry.registerScreen(() => true);
    const offGuard = registry.registerGuard(() => true);
    expect(registry.size()).toBe(2);
    offGuard();
    expect(registry.size()).toBe(1);
    offScreen();
    expect(registry.size()).toBe(0);
  });
});

describe('registerBackButton', () => {
  function fakeApp() {
    let callback: (() => void) | null = null;
    const removed = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const app: BackButtonApp = {
      addListener: vi.fn((_name: 'backButton', cb: () => void) => {
        callback = cb;
        return Promise.resolve({ remove: removed });
      }),
      exitApp: vi.fn(() => Promise.resolve()),
    };
    return { app, press: () => callback?.(), removed };
  }

  it('listens once, presses go through the registry, and the root press leaves through the plugin', () => {
    const { app, press } = fakeApp();
    const registry = createBackRegistry();
    registerBackButton(app, registry);
    expect(app.addListener).toHaveBeenCalledTimes(1);
    expect(app.addListener).toHaveBeenCalledWith('backButton', expect.any(Function));
    const handler = vi.fn(() => true);
    registry.registerScreen(handler);
    press();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(app.exitApp).not.toHaveBeenCalled();
    registry.registerScreen(() => false);
    const empty = createBackRegistry();
    const other = fakeApp();
    registerBackButton(other.app, empty);
    other.press();
    expect(other.app.exitApp).toHaveBeenCalledTimes(1);
  });

  it('a plugin that refuses the registration, or exits with a rejection, does not throw', async () => {
    const refusing: BackButtonApp = { addListener: () => Promise.reject(new Error('no plugin')), exitApp: () => Promise.reject(new Error('no plugin')) };
    expect(() => registerBackButton(refusing, createBackRegistry())).not.toThrow();
    const throwing: BackButtonApp = {
      addListener: () => {
        throw new Error('sync failure');
      },
      exitApp: () => Promise.resolve(),
    };
    expect(() => registerBackButton(throwing, createBackRegistry())).not.toThrow();
    await Promise.resolve();
  });

  it('an exit that the plugin rejects is handled: a rejection handler is attached to what exitApp returns', async () => {
    const { app, press } = fakeApp();
    const result = Promise.reject(new Error('no activity'));
    const handled = vi.spyOn(result, 'catch');
    (app.exitApp as ReturnType<typeof vi.fn>).mockImplementation(() => result);
    registerBackButton(app, createBackRegistry());
    press();
    expect(app.exitApp).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
    await result.catch(() => undefined);
  });

  it('stop removes the plugin listener', async () => {
    const { app, removed } = fakeApp();
    const stop = registerBackButton(app, createBackRegistry());
    stop();
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1));
  });
});
