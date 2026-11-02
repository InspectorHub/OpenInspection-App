import type { StackStatus } from '../../app/offline-stack';

export type ConnectionChipView = { label: 'Online' | 'Offline' | 'Server unreachable' | 'Sync paused'; tone: 'ok' | 'watch' | 'muted' };

/**
 * What the connection chip says. The device link comes first (no link is "Offline", whatever the stack thinks); with a link, a
 * server that cannot be reached or a sync that is paused replaces "Online", so the chip never contradicts the grey server line.
 * A sign-in problem (`auth`) is not a connection state and leaves the chip alone. Link unknown (null) shows no chip at all.
 */
export function connectionChip(online: boolean | null, status: Pick<StackStatus, 'auth' | 'serverUnreachable' | 'syncPaused'>): ConnectionChipView | null {
  if (online === null) return null;
  if (!online) return { label: 'Offline', tone: 'muted' };
  if (!status.auth) {
    if (status.serverUnreachable) return { label: 'Server unreachable', tone: 'watch' };
    if (status.syncPaused) return { label: 'Sync paused', tone: 'watch' };
  }
  return { label: 'Online', tone: 'ok' };
}
