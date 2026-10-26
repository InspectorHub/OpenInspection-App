import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { NotifyOptions, NotifyVariant } from '@inspectorhub/field-ui';
import type { TimerPort } from '../collab/timers';

/** How long a message stays when the editor does not ask for another time. */
export const TOAST_MS = 4000;

const TONE: Record<NotifyVariant, string> = {
  info: 'bg-ih-info-bg text-ih-info-fg',
  success: 'bg-ih-info-bg text-ih-info-fg',
  warning: 'bg-ih-watch-bg text-ih-watch-fg',
  error: 'bg-ih-bad-bg text-ih-bad-fg',
};

interface Toast {
  id: number;
  message: string;
  variant: NotifyVariant;
  action?: NotifyOptions['action'];
}

export interface Toasts {
  push(message: string, variant: NotifyVariant, options?: NotifyOptions): void;
  view: JSX.Element;
}

/** The editor's messages: a short-lived list at the bottom of the screen. Errors announce themselves, the rest are polite. */
export function useToasts(timers: TimerPort): Toasts {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(0);
  const pending = useRef(new Set<unknown>());

  useEffect(() => {
    const held = pending.current;
    return () => {
      for (const handle of held) timers.clearTimeout(handle);
      held.clear();
    };
  }, [timers]);

  const push = useCallback(
    (message: string, variant: NotifyVariant, options?: NotifyOptions) => {
      next.current += 1;
      const id = next.current;
      setItems((current) => [...current, { id, message, variant, ...(options?.action === undefined ? {} : { action: options.action }) }]);
      const handle = timers.setTimeout(() => {
        pending.current.delete(handle);
        setItems((current) => current.filter((item) => item.id !== id));
      }, options?.durationMs ?? TOAST_MS);
      pending.current.add(handle);
    },
    [timers],
  );

  const view = (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-[max(1rem,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]">
      {items.map((item) => (
        <div key={item.id} role={item.variant === 'error' ? 'alert' : 'status'} className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-ih-card px-3 py-2 text-sm shadow-ih-popover ${TONE[item.variant]}`}>
          <span>{item.message}</span>
          {item.action !== undefined && (
            <button
              type="button"
              className="min-h-11 font-semibold underline"
              onClick={() => {
                item.action?.run();
                setItems((current) => current.filter((other) => other.id !== item.id));
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
  return { push, view };
}
