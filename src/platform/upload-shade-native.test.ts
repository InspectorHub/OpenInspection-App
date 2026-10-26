import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NATIVE_DIR = join(process.cwd(), 'android', 'app', 'src', 'main', 'java', 'io', 'inspectorhub', 'app');
const shade = readFileSync(join(NATIVE_DIR, 'UploadShade.java'), 'utf8');
const observer = readFileSync(join(NATIVE_DIR, 'UploadShadeObserver.java'), 'utf8');
const policy = readFileSync(join(NATIVE_DIR, 'UploadSharePolicy.java'), 'utf8');
const model = readFileSync(join(NATIVE_DIR, 'UploadShadeModel.java'), 'utf8');
const mainActivity = readFileSync(join(NATIVE_DIR, 'MainActivity.java'), 'utf8');
const appGradle = readFileSync(join(process.cwd(), 'android', 'app', 'build.gradle'), 'utf8');
const pluginDir = join(process.cwd(), 'node_modules', '@capgo', 'capacitor-uploader', 'android');
const pluginSource = readFileSync(join(pluginDir, 'src', 'main', 'java', 'ee', 'forgr', 'capacitor', 'uploader', 'UploaderPlugin.java'), 'utf8');
const pluginGradle = readFileSync(join(pluginDir, 'build.gradle'), 'utf8');

describe('the upload notification is one quiet, rate-limited record (native wiring)', () => {
  it('uses the channel id the upload plugin posts to (read from the plugin itself, so a plugin update that renames it fails here)', () => {
    const pluginChannel = /CHANNEL_ID = "([^"]+)"/.exec(pluginSource)?.[1];
    expect(pluginChannel).toBeDefined();
    expect(shade).toContain(`UPLOAD_CHANNEL_ID = "${String(pluginChannel)}"`);
  });

  it('declares the same upload library version as the plugin, so the app compiles against the classes the plugin ships', () => {
    const pluginVersion = /net\.gotev:uploadservice:([0-9.]+)/.exec(pluginGradle)?.[1];
    const appVersion = /net\.gotev:uploadservice:([0-9.]+)/.exec(appGradle)?.[1];
    expect(pluginVersion).toBeDefined();
    expect(appVersion).toBe(pluginVersion);
  });

  it('creates the channel quietly (low importance, no sound, no vibration, no badge) and before the bridge, so the plugin cannot create it louder', () => {
    expect(shade).toContain('NotificationManager.IMPORTANCE_LOW');
    expect(shade).not.toMatch(/IMPORTANCE_(DEFAULT|HIGH|MAX)/);
    expect(shade).toMatch(/setSound\(null, null\)/);
    expect(shade).toMatch(/enableVibration\(false\)/);
    expect(shade).toMatch(/setShowBadge\(false\)/);
    expect(shade).toMatch(/if \(!UploadSharePolicy\.channelsExist\(Build\.VERSION\.SDK_INT\)\) return;/);
    expect(policy).toMatch(/sdkInt >= FIRST_CHANNEL_SDK/);
    expect(policy).toMatch(/FIRST_CHANNEL_SDK = 26/);
    const install = mainActivity.indexOf('UploadShade.install(this)');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(mainActivity.indexOf('super.onCreate'));
    // the channel is created before the handler is swapped and before any notification can be posted
    expect(shade.indexOf('ensureQuietChannel(context);')).toBeLessThan(shade.indexOf('setNotificationHandlerFactory'));
  });

  it('guards the channel-scoped cleanup by the API 26 gate before it touches getChannelId (it does not exist on Android 7)', () => {
    const cleanup = shade.slice(shade.indexOf('static void clearStale'));
    const gate = cleanup.indexOf('UploadSharePolicy.channelsExist(Build.VERSION.SDK_INT)');
    expect(gate).toBeGreaterThan(-1);
    expect(cleanup.indexOf('getNotification().getChannelId()')).toBeGreaterThan(gate);
    expect(cleanup.indexOf('getActiveNotifications()')).toBeGreaterThan(gate);
    expect(shade).not.toMatch(/VERSION_CODES\.M/);
  });

  it('recreates an existing channel that is louder than LOW, before the handler is swapped and before the bridge loads', () => {
    const ensure = shade.slice(shade.indexOf('static void ensureQuietChannel'), shade.indexOf('static void clearStale'));
    const decide = ensure.indexOf('UploadSharePolicy.mustRecreateChannel(existing.getImportance())');
    const del = ensure.indexOf('deleteNotificationChannel(UPLOAD_CHANNEL_ID)');
    const create = ensure.indexOf('createNotificationChannel(channel)');
    expect(decide).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(decide);
    expect(create).toBeGreaterThan(del);
    expect(shade.indexOf('ensureQuietChannel(context);')).toBeLessThan(shade.indexOf('setNotificationHandlerFactory'));
  });

  it('clears the held-flush flag at the start of the flush, so no plan can leave a flush marked as pending', () => {
    expect(observer).toContain('this::flushNow');
    const flush = observer.slice(observer.indexOf('private void flushNow()'), observer.indexOf('private void dispatchOnMain()'));
    expect(flush.indexOf('flushScheduled = false;')).toBeGreaterThan(-1);
    expect(flush.indexOf('flushScheduled = false;')).toBeLessThan(flush.indexOf('dispatchOnMain();'));
  });

  it('writes the title from a pool thread and reads it on the main thread, so it is volatile', () => {
    expect(observer).toMatch(/private volatile String title/);
  });

  it('replaces the library per-file notification handler with the single-notice observer', () => {
    expect(shade).toMatch(/setNotificationHandlerFactory\(service -> new UploadShadeObserver\(service\)\)/);
  });

  it('removes leftover notifications of the channel only while no upload runs (stale foreground notice after a crash)', () => {
    expect(shade).toContain('UploadService.getTaskList().isEmpty()');
    expect(shade).toContain('getActiveNotifications()');
    expect(shade).toMatch(/UPLOAD_CHANNEL_ID\.equals\(/);
    expect(shade.indexOf('clearStale(context);')).toBeGreaterThan(shade.indexOf('static void install'));
    expect(shade.indexOf('getTaskList().isEmpty()')).toBeLessThan(shade.indexOf('manager.cancel(posted.getTag()'));
  });

  it('posts only the one record, under the id of the library foreground notice, as a low, silent, ongoing notification', () => {
    expect(observer).toContain('NOTIFICATION_ID = 1234');
    const notifies = observer.match(/manager\.notify\(([^,)]+)/g) ?? [];
    expect(notifies).toEqual(['manager.notify(NOTIFICATION_ID']);
    const cancels = observer.match(/manager\.cancel\(([^,)]+)\)/g) ?? [];
    expect(cancels).toEqual(['manager.cancel(NOTIFICATION_ID)']);
    expect(observer).toContain('.setOngoing(true)');
    expect(observer).toContain('.setSilent(true)');
    expect(observer).toContain('.setOnlyAlertOnce(true)');
    expect(observer).toContain('NotificationCompat.PRIORITY_LOW');
    expect(observer).toContain('FOREGROUND_SERVICE_IMMEDIATE');
    expect(observer).toContain('UploadShade.UPLOAD_CHANNEL_ID');
  });

  it('posts through the rate limit only: the single post call is reached from the model plan, never straight from a library callback', () => {
    expect(observer.match(/(?<![.\w])post\(/g)?.length).toBe(2); // the one definition and the one call
    expect(observer).toContain('model.plan(now)');
    expect(observer).toContain('model.markPosted(plan.content, now)');
    const callbacks = observer.slice(observer.indexOf('public void onStart'), observer.indexOf('private void dispatch()'));
    expect(callbacks).not.toMatch(/(?<![.\w])post\(/);
    expect(callbacks).not.toContain('manager.');
  });

  it('keeps the decision logic free of Android types so the JVM unit test can run it (control: the observer does use them)', () => {
    expect(model).not.toMatch(/import android\./);
    expect(model).not.toMatch(/import androidx\./);
    expect(observer).toMatch(/import android\./);
  });

  it('keeps the dataSync foreground permissions the library service needs', () => {
    const manifest = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_DATA_SYNC');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE"');
  });
});
