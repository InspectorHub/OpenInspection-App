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

  it('removes the permissions the notification plugin would add on its own (boot restore and exact alarms)', () => {
    const removed = permissions(manifest)
      .filter((p) => p.remove)
      .map((p) => p.name)
      .sort();
    expect(removed).toEqual(['android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.SCHEDULE_EXACT_ALARM']);
    expect(manifest).toMatch(/xmlns:tools="http:\/\/schemas\.android\.com\/tools"/);
  });

  it('declares the notification permission once', () => {
    expect(permissions(manifest).filter((p) => p.name === 'android.permission.POST_NOTIFICATIONS')).toHaveLength(1);
  });
});
