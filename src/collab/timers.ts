/** Timer functions a collab component schedules with; tests substitute a manual one. */
export interface TimerPort {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Arrow wrappers, not the bare builtins: a WebView throws `Illegal invocation` when they run with another `this`. */
export const realTimers: TimerPort = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
