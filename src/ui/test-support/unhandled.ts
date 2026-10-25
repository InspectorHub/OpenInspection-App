/**
 * Collects promise rejections nobody handled while a test runs. A handler that lets an error escape ends up here, and in the
 * real WebView it would end up in the console and the system log with whatever text the error carried.
 */
export interface UnhandledWatch {
  readonly seen: unknown[];
  /** Gives the runtime the turns it needs to report a rejection that nothing handled, then stops listening. */
  finish(): Promise<unknown[]>;
}

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export function watchUnhandled(): UnhandledWatch {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  return {
    seen,
    finish: async () => {
      await turn();
      await turn();
      process.off('unhandledRejection', listener);
      return seen;
    },
  };
}
