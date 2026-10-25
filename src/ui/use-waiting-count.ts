import { useEffect, useState } from 'react';
import { realTimers, type TimerPort } from '../collab/timers';
import { countWaitingUploads } from '../offline/waiting';
import type { Db } from '../platform/db';

export const WAITING_POLL_MS = 3000;

/**
 * How many things on this device have not reached the server, read again every few seconds while the caller is mounted. One read
 * at a time and one timer at a time; nothing is left running after unmount. A read that fails keeps the last number. Null until
 * the first read has answered.
 */
export function useWaitingCount(db: Db, options: { pollMs?: number; timers?: TimerPort } = {}): number | null {
  const [count, setCount] = useState<number | null>(null);
  const pollMs = options.pollMs ?? WAITING_POLL_MS;
  const timers = options.timers ?? realTimers;
  useEffect(() => {
    let active = true;
    let handle: unknown = null;
    async function tick(): Promise<void> {
      try {
        const next = await countWaitingUploads(db);
        if (active) setCount(next);
      } catch {
        // Keep the last number.
      }
      if (active) handle = timers.setTimeout(() => void tick(), pollMs);
    }
    void tick();
    return () => {
      active = false;
      if (handle !== null) timers.clearTimeout(handle);
    };
  }, [db, pollMs, timers]);
  return count;
}
