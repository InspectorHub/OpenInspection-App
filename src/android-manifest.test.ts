import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

/** Every `<uses-permission>` element with its attributes, comments removed first. */
function permissions(xml: string): Array<{ name: string; remove: boolean }> {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  return [...withoutComments.matchAll(/<uses-permission\b([^>]*?)\/?>/g)].map((match) => {
    const attributes = match[1] ?? '';
    return {
      name: /android:name="([^"]+)"/.exec(attributes)?.[1] ?? '',
      remove: /tools:node="remove"/.test(attributes),
    };
  });
}

describe('the Android manifest permissions', () => {
  it('reads permissions out of markup (control for the pinned list below)', () => {
    expect(permissions('<!-- <uses-permission android:name="x.A" /> --><uses-permission android:name="x.B"/><uses-permission android:name="x.C" tools:node="remove" />')).toEqual([
      { name: 'x.B', remove: false },
      { name: 'x.C', remove: true },
    ]);
  });

  it('asks for exactly these permissions: the network, the camera, the upload foreground service and the notification for it', () => {
    const asked = permissions(manifest)
      .filter((p) => !p.remove)
      .map((p) => p.name);
    expect(asked).toEqual([
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.POST_NOTIFICATIONS',
    ]);
  });

  it('removes the permissions that arrive through plugins and that the app never uses (boot restore, exact alarms, biometrics)', () => {
    const removed = permissions(manifest)
      .filter((p) => p.remove)
      .map((p) => p.name)
      .sort();
    expect(removed).toEqual([
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.SCHEDULE_EXACT_ALARM',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
    ]);
    expect(manifest).toMatch(/xmlns:tools="http:\/\/schemas\.android\.com\/tools"/);
  });

  it('keeps READ_EXTERNAL_STORAGE out of the source manifest on purpose: it is transitive and stays until an upload test on Android 9 to 12 allows removing it', () => {
    expect(permissions(manifest).map((p) => p.name)).not.toContain('android.permission.READ_EXTERNAL_STORAGE');
    expect(manifest).toContain('READ_EXTERNAL_STORAGE');
  });

  it('removes the notification plugin components that only serve scheduled notifications, by their exact names', () => {
    const removedComponents = [...manifest.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(receiver|provider|service|activity)\b([^>]*?)\/?>/g)]
      .filter((m) => /tools:node="remove"/.test(m[2] ?? ''))
      .map((m) => `${m[1] ?? ''} ${/android:name="([^"]+)"/.exec(m[2] ?? '')?.[1] ?? ''}`)
      .sort();
    expect(removedComponents).toEqual([
      'provider com.capacitorjs.plugins.localnotifications.LocalNotificationsAssetProvider',
      'receiver com.capacitorjs.plugins.localnotifications.LocalNotificationRestoreReceiver',
      'receiver com.capacitorjs.plugins.localnotifications.NotificationDismissReceiver',
      'receiver com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher',
    ]);
  });

  it('removes nothing that the upload service or the camera need (control: the app own provider and activity are untouched)', () => {
    expect(manifest).toMatch(/<provider\s+android:name="androidx\.core\.content\.FileProvider"(?![^>]*tools:node)/);
    expect(manifest).toMatch(/<activity[^>]*android:name="\.MainActivity"(?![^>]*tools:node)/);
  });

  it('declares the notification permission once', () => {
    expect(permissions(manifest).filter((p) => p.name === 'android.permission.POST_NOTIFICATIONS')).toHaveLength(1);
  });
});
