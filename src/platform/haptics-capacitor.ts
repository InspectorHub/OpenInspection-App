import { Haptics, NotificationType } from '@capacitor/haptics';
import type { HapticKind, HapticsPort } from './haptics';

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

/** Thin real-plugin wiring. */
export function createRealHaptics(): HapticsPort {
  return createCapacitorHaptics(Haptics);
}
