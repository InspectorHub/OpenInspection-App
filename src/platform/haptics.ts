import { Haptics, NotificationType } from '@capacitor/haptics';

/** The two feelings the app uses: a finished action that went well, and one that cannot be undone. */
export type HapticKind = 'success' | 'warning';

export interface HapticsPort {
  notify(kind: HapticKind): Promise<void>;
}

/** The part of the Haptics plugin the app uses. */
export interface HapticsPluginLike {
  notification(options: { type: NotificationType }): Promise<void>;
}

const TYPES: Record<HapticKind, NotificationType> = {
  success: NotificationType.Success,
  warning: NotificationType.Warning,
};

export function createCapacitorHaptics(plugin: HapticsPluginLike): HapticsPort {
  return { notify: (kind) => plugin.notification({ type: TYPES[kind] }) };
}

let installed: HapticsPort | null = null;

/** Replaces the port every `haptic` call uses; null restores the plugin. Tests use it. */
export function setHapticsPort(port: HapticsPort | null): void {
  installed = port;
}

/**
 * A short vibration for a key action (confirming something destructive, a finished export, signing out). Fire and forget: a
 * device without the hardware, a missing plugin or a refusal never reaches the action that asked for it.
 */
export function haptic(kind: HapticKind): void {
  try {
    const port = installed ?? createCapacitorHaptics(Haptics);
    port.notify(kind).catch(() => undefined);
  } catch {
    // No plugin to ask.
  }
}
