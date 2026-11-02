/** The two feelings the app uses: a finished action that went well, and one that cannot be undone. */
export type HapticKind = 'success' | 'warning';

export interface HapticsPort {
  notify(kind: HapticKind): Promise<void>;
}

let installed: HapticsPort | null = null;

/** Sets the port every `haptic` call uses; null removes it, which is how a client with no vibration hardware runs. */
export function setHapticsPort(port: HapticsPort | null): void {
  installed = port;
}

/**
 * A short vibration for a key action (confirming something destructive, a finished export, signing out). Fire and forget: a
 * device without the hardware, a missing plugin or a refusal never reaches the action that asked for it. With no port set
 * it does nothing.
 */
export function haptic(kind: HapticKind): void {
  try {
    installed?.notify(kind).catch(() => undefined);
  } catch {
    // No plugin to ask.
  }
}
