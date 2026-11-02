export interface NotificationLike {
  show(): void;
}

export interface NotificationCtor {
  new(options: { title: string; body: string }): NotificationLike;
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;

export function createUploadNotifier(deps: {
  Notification: NotificationCtor;
  isFocused(): boolean;
  now(): number;
  minIntervalMs?: number;
}): { onDrained(options: { failures: number; completed: number }): void } {
  let lastShownAt = Number.NEGATIVE_INFINITY;
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  return {
    onDrained({ failures, completed }) {
      // Only a finished batch in which something was uploaded or failed is news, and only the notification actually shown takes the throttle slot.
      if (completed + failures <= 0 || deps.isFocused() || deps.now() - lastShownAt < minIntervalMs) return;
      lastShownAt = deps.now();
      const body = failures > 0 ? 'InspectorHub: some photos could not be uploaded' : 'InspectorHub: uploads finished';
      new deps.Notification({ title: 'InspectorHub', body }).show();
    },
  };
}
