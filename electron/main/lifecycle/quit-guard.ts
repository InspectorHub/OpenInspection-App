/** E2E can answer the native confirmation in development; packaged clients always show the real dialog. */
export function developmentQuitAnswer(isPackaged: boolean, answer: string | undefined): 'quit' | 'stay' | null {
  if (isPackaged) return null;
  return answer === 'quit' || answer === 'stay' ? answer : null;
}

export function createQuitGuard(deps: {
  uploads(): number;
  confirm(): Promise<'quit' | 'stay'>;
  shutdown(): Promise<void>;
  quit(): void;
}): { onClose(event: { preventDefault(): void }): Promise<void> } {
  let allowClose = false;
  let pending: Promise<void> | null = null;
  return {
    async onClose(event) {
      if (allowClose) return;
      event.preventDefault();
      if (pending) return pending;
      pending = (async () => {
        if (deps.uploads() > 0 && await deps.confirm() !== 'quit') return;
        await deps.shutdown();
        allowClose = true;
        try { deps.quit(); }
        catch (error) { allowClose = false; throw error; }
      })();
      try { await pending; }
      finally { pending = null; }
    },
  };
}
