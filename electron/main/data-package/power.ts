/**
 * Keeps the machine awake while a data job holds the floor, and tells the job
 * to pause when the OS suspends. A job may acquire the guard more than once
 * (e.g. rows + media); the blocker is held only while the count is above zero.
 */
import type { PowerMonitorLike } from '../lifecycle/power.ts';

export interface PowerBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export type DataPackagePowerMonitor = PowerMonitorLike;

export interface DataPackagePowerGuardDeps {
  blocker: PowerBlockerLike;
  powerMonitor: DataPackagePowerMonitor;
  onSuspend?(): void;
  onResume?(): void;
}

export interface DataPackagePowerGuard {
  acquire(): void;
  release(): void;
  activeCount(): number;
  dispose(): void;
}

export function createDataPackagePowerGuard(deps: DataPackagePowerGuardDeps): DataPackagePowerGuard {
  let count = 0;
  let blockerId: number | null = null;
  let disposed = false;

  const listeners: Array<['suspend' | 'resume' | 'lock-screen' | 'unlock-screen', () => void]> = [
    ['suspend', () => { if (!disposed) deps.onSuspend?.(); }],
    ['resume', () => { if (!disposed) deps.onResume?.(); }],
    ['lock-screen', () => undefined],
    ['unlock-screen', () => undefined],
  ];
  for (const [event, listener] of listeners) deps.powerMonitor.on(event, listener);

  return {
    acquire() {
      if (disposed) return;
      count += 1;
      if (count === 1 && blockerId === null) blockerId = deps.blocker.start('prevent-app-suspension');
    },
    release() {
      if (disposed || count === 0) return;
      count -= 1;
      if (count === 0 && blockerId !== null) {
        deps.blocker.stop(blockerId);
        blockerId = null;
      }
    },
    activeCount() { return count; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [event, listener] of listeners) deps.powerMonitor.removeListener(event, listener);
      if (blockerId !== null) {
        deps.blocker.stop(blockerId);
        blockerId = null;
      }
      count = 0;
    },
  };
}
