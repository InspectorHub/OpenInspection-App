import type { ComponentType } from 'react';
import type { AppServices } from '../app/compose';
import type { OfflineStack } from '../app/offline-stack';
import type { TimerPort } from '../collab/timers';

export interface ImportScreenProps {
  services: Pick<AppServices, 'http' | 'tokens' | 'platform' | 'appVersion' | 'clientState' | 'files' | 'sharer' | 'clock'>;
  origin: string;
  /** The offline stack of this session: the account the package must belong to, and the lock and version gates of every request. */
  stack: Pick<OfflineStack, 'account' | 'locked' | 'serverTooOld'>;
  /** Replaces the timers that schedule the delayed deletion of a saved part on Android. */
  timers?: TimerPort | undefined;
  /** Back to Settings. */
  onClose(): void;
  /** Sends the person to the sign-in screen (which leaves this screen). Without it a sign-in stop offers "Try again". */
  onSignInAgain?: (() => void) | undefined;
}

/**
 * How the import screen's chunk is loaded. The screen reads packages with the shared offline-package reader (and zod behind it), so
 * it is a chunk of its own that only Settings' "Import package" asks for. The props are declared here, not taken from the screen's
 * module, because even a type-only reference would put the screen in the static import graph. A seam so a test can make the load
 * fail, or wait.
 */
export const importModule: { load(): Promise<{ ImportScreen: ComponentType<ImportScreenProps> }> } = {
  load: () => import('./import/ImportScreen'),
};
