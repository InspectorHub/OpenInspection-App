import type { UploaderHost } from '../net/uploader-host.ts';

export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
}

export function createPowerBridge(deps: {
  powerMonitor: PowerMonitorLike;
  uploader: Pick<UploaderHost, 'abortAll'>;
  emitActive(active: boolean): void;
}): () => void {
  const listeners: Array<['suspend' | 'resume' | 'lock-screen' | 'unlock-screen', () => void]> = [
    ['suspend', () => { deps.uploader.abortAll('suspend'); deps.emitActive(false); }],
    ['resume', () => deps.emitActive(true)],
    ['unlock-screen', () => deps.emitActive(true)],
    ['lock-screen', () => undefined],
  ];
  for (const [event, listener] of listeners) deps.powerMonitor.on(event, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [event, listener] of listeners) deps.powerMonitor.removeListener(event, listener);
  };
}

export function createPowerSaveGuard(deps: {
  blocker: { start(type: 'prevent-app-suspension'): number; stop(id: number): void };
  uploader: Pick<UploaderHost, 'onActiveCountChange'>;
}): () => void {
  let blockerId: number | null = null;
  let disposed = false;
  const unsubscribe = deps.uploader.onActiveCountChange((count) => {
    if (disposed) return;
    if (count > 0 && blockerId === null) blockerId = deps.blocker.start('prevent-app-suspension');
    else if (count === 0 && blockerId !== null) {
      deps.blocker.stop(blockerId);
      blockerId = null;
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (blockerId !== null) {
      deps.blocker.stop(blockerId);
      blockerId = null;
    }
  };
}
