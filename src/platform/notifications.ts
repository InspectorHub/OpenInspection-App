import type { ClientPlatform } from '../app/compose';

/**
 * What the app knows about the system's notification permission. `unsupported` is every platform where the app does not need one
 * (only Android shows a notification, for the foreground service that keeps uploads running) and a plugin that cannot answer.
 */
export type NotificationState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface NotificationPermissionPort {
  check(): Promise<NotificationState>;
  /** Shows the system prompt (Android 13 and later) and returns the answer. */
  request(): Promise<NotificationState>;
}

/** The part of the Local Notifications plugin the app uses: its permission calls only. Nothing is ever scheduled. */
export interface NotificationPluginLike {
  checkPermissions(): Promise<{ display?: string }>;
  requestPermissions(): Promise<{ display?: string }>;
}

function stateOf(raw: string | undefined): NotificationState {
  switch (raw) {
    case 'granted':
      return 'granted';
    case 'prompt':
    case 'prompt-with-rationale':
      return 'prompt';
    default:
      // An answer this code does not know is never read as permission.
      return 'denied';
  }
}

export function createNotificationPermission(plugin: NotificationPluginLike, platform: ClientPlatform): NotificationPermissionPort {
  const ask = async (call: () => Promise<{ display?: string }>): Promise<NotificationState> => {
    if (platform !== 'android') return 'unsupported';
    try {
      return stateOf((await call()).display);
    } catch {
      return 'unsupported';
    }
  };
  return {
    check: () => ask(() => plugin.checkPermissions()),
    request: () => ask(() => plugin.requestPermissions()),
  };
}
