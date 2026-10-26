import { LocalNotifications } from '@capacitor/local-notifications';
import type { ClientPlatform } from '../app/compose';
import { createNotificationPermission, type NotificationPermissionPort } from './notifications';

/** Thin real-plugin wiring. */
export function createRealNotificationPermission(platform: ClientPlatform): NotificationPermissionPort {
  return createNotificationPermission(LocalNotifications, platform);
}
