export interface AppLike {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): unknown;
}

const instances = new WeakMap<object, boolean>();

export function createSingleInstance(deps: { app: AppLike; onSecond(argv: readonly string[]): void; focus(): void }): boolean {
  const previous = instances.get(deps.app);
  if (previous !== undefined) return previous;
  const locked = deps.app.requestSingleInstanceLock();
  instances.set(deps.app, locked);
  // Quit normally with code zero; index performs no startup work after a losing lock.
  if (!locked) { deps.app.quit(); return false; }
  deps.app.on('second-instance', (_event, argv) => {
    try { deps.onSecond(argv); } catch { /* A callback failure must not terminate the winning process. */ }
    try { deps.focus(); } catch { /* A closing native window may disappear during focus. */ }
  });
  return true;
}
