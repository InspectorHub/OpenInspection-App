/**
 * The Android back key and back gesture, from one place.
 *
 * Without a listener the system back key leaves the app from any screen. One listener is registered at start and every press
 * is answered here, in this order:
 *  1. an open modal, dialog or overlay: a cancelable Escape key event is sent to the window, and a layer that closed itself
 *     calls `preventDefault` on it (see `escape-layer.ts`), which means the press is used up;
 *  2. a screen handler (Settings back to the list, a sign-in step back to the one before). The most recently registered one is
 *     asked first; a handler that returns false declines and the next one below it is asked;
 *  3. an unsaved-work guard. It is asked only when no screen handler wanted the press, that is, when the press would leave the
 *     app. A guard that returns true keeps the person in the app (it shows its own question). The editor registers here;
 *  4. otherwise the app exits.
 *
 * The editor's own item-to-list level is inside the field-ui package and cannot be reached from the host until the package
 * exports a handler for it; until then the editor screen can only register a guard, and a press on it follows tiers 1 to 4.
 *
 * A handler that throws never swallows the press: it counts as declining and the next handler is asked, so a broken screen can
 * at worst let the app exit, never trap the person.
 */

/** Returns true when it used the press up. */
export type BackHandler = () => boolean;

export interface BackRegistry {
  /** Screen handlers: the most recently registered is asked first. Returns the function that removes this registration. */
  registerScreen(handler: BackHandler): () => void;
  /** Unsaved-work guards: asked only when the press would leave the app. Returns the function that removes this registration. */
  registerGuard(handler: BackHandler): () => void;
  /** The handlers in ask order. */
  screens(): readonly BackHandler[];
  guards(): readonly BackHandler[];
  /** How many registrations are held, of both kinds. For tests and leak checks. */
  size(): number;
}

export function createBackRegistry(): BackRegistry {
  // Each registration is its own entry, even for the same function, so removing one never removes another.
  const screens: Array<{ handler: BackHandler }> = [];
  const guards: Array<{ handler: BackHandler }> = [];
  const add = (list: Array<{ handler: BackHandler }>, handler: BackHandler): (() => void) => {
    const entry = { handler };
    list.push(entry);
    return () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  };
  return {
    registerScreen: (handler) => add(screens, handler),
    registerGuard: (handler) => add(guards, handler),
    screens: () => screens.map((entry) => entry.handler).reverse(),
    guards: () => guards.map((entry) => entry.handler).reverse(),
    size: () => screens.length + guards.length,
  };
}

/** The registry the screens use. */
export const backRegistry: BackRegistry = createBackRegistry();

export interface BackDeps {
  exitApp(): void;
  /** Where the Escape key event is sent. The window in the app. */
  escapeTarget: EventTarget;
}

function consumed(handler: BackHandler): boolean {
  try {
    return handler() === true;
  } catch {
    return false;
  }
}

function modalConsumed(target: EventTarget): boolean {
  try {
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  } catch {
    return false;
  }
}

/** Answers one press of the back key. */
export function pressBack(registry: BackRegistry, deps: BackDeps): void {
  if (modalConsumed(deps.escapeTarget)) return;
  for (const handler of registry.screens()) if (consumed(handler)) return;
  for (const handler of registry.guards()) if (consumed(handler)) return;
  try {
    deps.exitApp();
  } catch {
    // Nothing is left to do: the plugin that leaves the app is not there.
  }
}

/** The part of `@capacitor/app` the back key uses. */
export interface BackButtonApp {
  addListener(name: 'backButton', callback: () => void): Promise<{ remove(): Promise<void> }>;
  exitApp(): Promise<void>;
}

/**
 * Registers the one back-key listener. Returns the function that removes it. A plugin that refuses the registration leaves the
 * system's own behaviour in place.
 */
export function registerBackButton(app: BackButtonApp, registry: BackRegistry = backRegistry, escapeTarget: EventTarget = window): () => void {
  let registration: Promise<{ remove(): Promise<void> }> | null = null;
  try {
    registration = app.addListener('backButton', () => {
      pressBack(registry, {
        exitApp: () => {
          app.exitApp().catch(() => undefined);
        },
        escapeTarget,
      });
    });
  } catch {
    registration = null;
  }
  registration?.catch(() => undefined);
  return () => {
    registration?.then((handle) => handle.remove()).catch(() => undefined);
    registration = null;
  };
}
