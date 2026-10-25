import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withQuietShade, type UploaderEventLike, type UploaderPluginLike } from './uploader';
import type { UploadShadePort } from './upload-shade';

function fakePlugin(): UploaderPluginLike & { emit(event: UploaderEventLike): void; removed: number } {
  let listener: (event: UploaderEventLike) => void = () => undefined;
  const plugin = {
    removed: 0,
    startUpload: vi.fn(() => Promise.resolve({ id: 'u1' })),
    removeUpload: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((_name: 'events', next: (event: UploaderEventLike) => void) => {
      listener = next;
      return Promise.resolve({
        remove: () => {
          plugin.removed += 1;
          return Promise.resolve();
        },
      });
    }),
    acknowledgeEvent: vi.fn(() => Promise.resolve()),
    emit: (event: UploaderEventLike) => listener(event),
  };
  return plugin;
}

function fakeShade(failing = false): UploadShadePort & { tidy: ReturnType<typeof vi.fn> } {
  return { tidy: vi.fn(() => (failing ? Promise.reject(new Error('no plugin')) : Promise.resolve())) };
}

describe('the upload notifications are kept to the one ongoing notice', () => {
  it('clears the finished-upload notifications once when the listener attaches (leftovers of an earlier run)', async () => {
    const shade = fakeShade();
    await withQuietShade(fakePlugin(), shade).addListener('events', () => undefined);
    expect(shade.tidy).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed'])('clears them after a %s event has been delivered to the app, and the app still sees the event first', async (name) => {
    const shade = fakeShade();
    const plugin = fakePlugin();
    const seen: string[] = [];
    await withQuietShade(plugin, shade).addListener('events', (event) => {
      seen.push(`${event.name}:${String(shade.tidy.mock.calls.length)}`);
    });
    plugin.emit({ name, id: 'u1', eventId: 'e1' });
    expect(seen).toEqual([`${name}:1`]);
    expect(shade.tidy).toHaveBeenCalledTimes(2);
  });

  it('does not touch the notifications for progress, started or cancelled events (control: only the terminal ones clear)', async () => {
    const shade = fakeShade();
    const plugin = fakePlugin();
    await withQuietShade(plugin, shade).addListener('events', () => undefined);
    for (const name of ['uploading', 'started', 'cancelled']) plugin.emit({ name, id: 'u1' });
    expect(shade.tidy).toHaveBeenCalledTimes(1);
  });

  it('a notification layer that fails never breaks the upload events or the listener setup', async () => {
    const shade = fakeShade(true);
    const plugin = fakePlugin();
    const seen: string[] = [];
    await withQuietShade(plugin, shade).addListener('events', (event) => seen.push(event.name));
    plugin.emit({ name: 'completed', id: 'u1', eventId: 'e1' });
    expect(seen).toEqual(['completed']);
  });

  it('hands every other call through unchanged', async () => {
    const plugin = fakePlugin();
    const wrapped = withQuietShade(plugin, fakeShade());
    await wrapped.startUpload({ filePath: 'file:///a', serverUrl: 'https://x', method: 'POST', uploadType: 'multipart', fileField: 'file', mimeType: 'image/jpeg', maxRetries: 3, headers: {}, notificationTitle: 'Uploading photos' });
    await wrapped.removeUpload({ id: 'u1' });
    await wrapped.acknowledgeEvent({ eventId: 'e1' });
    expect(plugin.startUpload).toHaveBeenCalledTimes(1);
    expect(plugin.removeUpload).toHaveBeenCalledWith({ id: 'u1' });
    expect(plugin.acknowledgeEvent).toHaveBeenCalledWith({ eventId: 'e1' });
  });
});

const NATIVE_DIR = join(process.cwd(), 'android', 'app', 'src', 'main', 'java', 'io', 'inspectorhub', 'app');
const shadeSource = readFileSync(join(NATIVE_DIR, 'UploadShadePlugin.java'), 'utf8');
const mainActivity = readFileSync(join(NATIVE_DIR, 'MainActivity.java'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'node_modules', '@capgo', 'capacitor-uploader', 'android', 'src', 'main', 'java', 'ee', 'forgr', 'capacitor', 'uploader', 'UploaderPlugin.java'), 'utf8');

describe('the native side of the upload notifications', () => {
  it('uses the channel id the upload plugin posts to (read from the plugin itself, so a plugin update that renames it fails here)', () => {
    const pluginChannel = /CHANNEL_ID = "([^"]+)"/.exec(pluginSource)?.[1];
    expect(pluginChannel).toBeDefined();
    expect(shadeSource).toContain(`"${String(pluginChannel)}"`);
  });

  it('creates the channel quietly: low importance, no sound, no vibration, no badge, before the plugin can create it louder', () => {
    expect(shadeSource).toContain('NotificationManager.IMPORTANCE_LOW');
    expect(shadeSource).not.toMatch(/IMPORTANCE_(DEFAULT|HIGH|MAX)/);
    expect(shadeSource).toMatch(/setSound\(null, null\)/);
    expect(shadeSource).toMatch(/enableVibration\(false\)/);
    expect(shadeSource).toMatch(/setShowBadge\(false\)/);
    const create = mainActivity.indexOf('UploadShadePlugin.ensureQuietChannel');
    const superCreate = mainActivity.indexOf('super.onCreate');
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(superCreate);
    expect(mainActivity).toContain('registerPlugin(UploadShadePlugin.class)');
    expect(mainActivity.indexOf('registerPlugin(UploadShadePlugin.class)')).toBeLessThan(superCreate);
  });

  it('removes only finished notifications of that channel: never an ongoing one and never the foreground-service one', () => {
    expect(shadeSource).toContain('getActiveNotifications()');
    expect(shadeSource).toMatch(/UPLOAD_CHANNEL_ID\.equals\(/);
    expect(shadeSource).toContain('isOngoing()');
    expect(shadeSource).toContain('FLAG_FOREGROUND_SERVICE');
  });

  it('is exposed to the web layer under the name the web layer registers', () => {
    expect(shadeSource).toContain('@CapacitorPlugin(name = "UploadShade")');
    expect(readFileSync(join(process.cwd(), 'src', 'platform', 'upload-shade.ts'), 'utf8')).toContain("registerPlugin<UploadShadeNative>('UploadShade')");
  });
});
