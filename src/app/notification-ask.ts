import type { KeyValue } from '../platform/kv';
import type { NotificationPermissionPort, NotificationState } from '../platform/notifications';

/** The memory of the question: `asked` (the system prompt was shown) or `declined` (the person said "Not now"). Either ends the asking. */
export const ASK_KEY = 'oi.notification-ask';

export interface NotificationAsk {
  /**
   * True when the app should show its own explanation now: the permission is still open, and this device never asked or was
   * told "Not now". Anything that cannot be read counts as "do not ask".
   */
  shouldExplain(): Promise<boolean>;
  /** Shows the system prompt and remembers that it was shown. Also the action behind the Settings button. */
  accept(): Promise<NotificationState>;
  /** The person said "Not now": remembered, and the explanation does not come back by itself. */
  decline(): Promise<void>;
}

export interface NotificationAskDeps {
  kv: KeyValue;
  permission: NotificationPermissionPort;
}

export function createNotificationAsk({ kv, permission }: NotificationAskDeps): NotificationAsk {
  const remember = async (value: 'asked' | 'declined'): Promise<void> => {
    try {
      await kv.set(ASK_KEY, value);
    } catch {
      // A memory that cannot be written costs one more explanation next time, never the answer the person just gave.
    }
  };
  return {
    shouldExplain: async () => {
      try {
        if ((await kv.get(ASK_KEY)) !== null) return false;
        return (await permission.check()) === 'prompt';
      } catch {
        return false;
      }
    },
    accept: async () => {
      const answer = await permission.request();
      await remember('asked');
      return answer;
    },
    decline: () => remember('declined'),
  };
}
