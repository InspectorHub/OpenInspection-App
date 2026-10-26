import type { StackDiagnostic } from './offline-stack';

/** How many codes the ring keeps. Small on purpose: it is a hint for a settings screen, not a log. */
export const DIAGNOSTIC_RING_SIZE = 20;

export interface DiagnosticRing<C extends string> {
  /** Records one fixed code, dropping the oldest when the ring is full. */
  push(code: C): void;
  /** The recorded codes, oldest first. A copy. */
  recent(): readonly C[];
}

/** Keeps the latest fixed diagnostic codes in memory. Codes only: never an id, a path, a url or a message. */
export function createDiagnosticRing<C extends string>(capacity: number = DIAGNOSTIC_RING_SIZE): DiagnosticRing<C> {
  const kept: C[] = [];
  return {
    push: (code) => {
      kept.push(code);
      if (kept.length > capacity) kept.splice(0, kept.length - capacity);
    },
    recent: () => [...kept],
  };
}

/** The app-wide ring: the codes of every stack this process built, and of the stack factory itself. */
export const appDiagnostics: DiagnosticRing<StackDiagnostic> = createDiagnosticRing<StackDiagnostic>();
