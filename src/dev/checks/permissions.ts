import { guarded, pass, type CheckDef } from './types';

const def = { id: 'permissions', title: '[diag] permissions: notification permission and the upload notification' };

const KNOWN = new Set(['granted', 'denied', 'default']);

export const permissions: CheckDef = {
  ...def,
  hint: 'Reads the WebView notification permission. Then start the kill test, pull down the notification shade and look for "Uploading photos".',
  run: (ctx) =>
    guarded(def, () => {
      const raw = ctx.deps.ports.notificationPermission();
      const permission = KNOWN.has(raw) ? raw : 'unknown';
      return Promise.resolve(pass(def, `notification_permission=${permission} upload_notification=operator_observes_shade_during_kill_test`));
    }),
};
