import type { UpdaterState } from '../../electron/shared/ipc-contract';

/** Renderer-safe, user-facing desktop information and actions. It never exposes filesystem paths. */
export interface DesktopSettingsPort {
  appVersion: string;
  updater: UpdaterState;
  checkForUpdates(): void;
  openLogs(): void;
  openDataFolder(): void;
}
