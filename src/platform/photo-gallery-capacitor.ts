import { Capacitor } from '@capacitor/core';
import { Media } from '@capacitor-community/media';
import { FileSharer } from '@capgo/capacitor-file-sharer';
import { bytesToBase64 } from './base64';
import type { GallerySaveResult, PhotoGallery } from './photo-gallery';

/** The album the copies go into on Android. See `createCapacitorGallery` for where that is on the phone. */
export const GALLERY_ALBUM_NAME = 'InspectorHub';

/** The part of the @capacitor-community/media plugin the app uses. */
export interface MediaPluginLike {
  savePhoto(options: { path: string; albumIdentifier?: string; fileName?: string }): Promise<unknown>;
  createAlbum(options: { name: string }): Promise<void>;
  getAlbums(): Promise<{ albums: Array<{ identifier: string; name: string }> }>;
  getAlbumsPath(): Promise<{ path: string }>;
}

/** The part of the @capgo/capacitor-file-sharer plugin the app uses (its Android save writes through MediaStore). */
export interface FileSharerLike {
  save(options: {
    filename: string;
    base64Data: string;
    contentType: string;
    android: { saveDirectory: 'pictures'; relativePath: string };
  }): Promise<unknown>;
}

export interface CapacitorGalleryOptions {
  platform: 'android' | 'ios';
  media: MediaPluginLike;
  /** Saves into the shared Pictures folder through MediaStore. Used on Android 10 and later; absent, nothing changes. */
  fileSharer?: FileSharerLike;
  /** The Android major version (10, 11, ...), or null when it is not known. Below 10 or unknown, the media plugin is used. */
  androidMajor?: number | null | (() => Promise<number | null>);
}

/** The first Android version whose MediaStore takes a RELATIVE_PATH, and so a photo can go to Pictures without any storage permission. */
export const MEDIASTORE_MIN_ANDROID = 10;

/**
 * The Android major version out of the WebView's user agent ("... Linux; Android 10; ALP-AL00 ..."), or null. A user agent that carries
 * no version is "unknown", which takes the media plugin: it works everywhere. Not enough on its own: see `androidMajorFromNavigator`.
 */
export function androidMajorFromUserAgent(userAgent: string): number | null {
  const match = /\bAndroid (\d{1,2})(?:[.;)\s]|$)/.exec(userAgent);
  if (match?.[1] === undefined) return null;
  const major = Number(match[1]);
  return major >= 2 ? major : null;
}

/** The part of `navigator` the version lookup reads. */
export interface NavigatorLike {
  userAgent: string;
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }> };
}

/**
 * The Android major version of this phone, or null. The WebView's user agent is being frozen to "Android 10; K" (Google's user-agent
 * reduction for WebView), so it is only the second choice: the User-Agent Client Hints `platformVersion` ("10.0.0", "14.0.0") is asked
 * first. A phone that answers neither is "unknown", which takes the media plugin: it works on every version.
 */
export async function androidMajorFromNavigator(nav: NavigatorLike): Promise<number | null> {
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues(['platformVersion']);
    const match = /^(\d{1,2})(?:\.|$)/.exec(hints?.platformVersion ?? '');
    const major = match?.[1] === undefined ? 0 : Number(match[1]);
    if (major >= 2) return major;
  } catch {
    // Not offered here: the user agent is the next choice.
  }
  return androidMajorFromUserAgent(nav.userAgent);
}

/**
 * How a refusal of access to the photo library looks when the plugin rejects. Read from its source (9.1.0):
 *  - Android, with the plugin's gallery mode on (this app does not turn it on, so this does not happen today): code `accessDenied`.
 *  - iOS: the message "Access to photos not allowed by user".
 * A broader match on "denied" or "permission" is NOT used: Android wraps a file-system error as "Error occurred:
 * java.lang.RuntimeException: ... (Permission denied)", which is a failed write, not something the person can allow in Settings.
 */
const REFUSED_CODE = 'accessDenied';
/** The plugin's message when the album folder it was told about is not there (any more). */
const ALBUM_GONE = /Album identifier does not exist/i;
const REFUSED_TEXT = /not allowed by user|user denied permission/i;

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return typeof error === 'string' ? error : '';
}

function refused(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    if ((error as { code?: unknown }).code === REFUSED_CODE) return true;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return REFUSED_TEXT.test(message);
  }
  return typeof error === 'string' && REFUSED_TEXT.test(error);
}

/** Without the extension, which the plugin adds on Android, and with nothing that is not a letter, digit, dash or underscore. */
export function albumFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_-]/g, '');
}

/** A name the file system and the media index take as it is: letters, digits, dot, dash, underscore, and an extension. */
export function safeFileName(name: string): string {
  // No leading dot: Android treats such a file as hidden, and a gallery would not list it.
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
  return /\.[A-Za-z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned || 'photo'}.jpg`;
}

/**
 * The phone's photo library. Saving is best effort and never throws.
 *
 * Android 10 and later: the photo goes to the shared Pictures folder, Pictures/InspectorHub, through MediaStore (@capgo/capacitor-file-sharer,
 * MPL-2.0). Measured on a Huawei ALP-AL00, Android 10 (2026-11-02): the file lands in /sdcard/Pictures/InspectorHub, the index lists it with
 * that relative path, the phone's gallery shows an album "InspectorHub", no permission is asked, and a normal UNINSTALL of the app leaves the
 * photo where it is (the index drops the owner). That is why it is used where it can be.
 *
 * Android 9 and earlier, or a version that cannot be read: @capacitor-community/media. Its Android albums are folders in the app's own media
 * folder, so there the copies are deleted with the app. The file sharer cannot do better on those versions (below Android 10 it writes the
 * file directly and needs a storage permission nobody asks for). The details of the media plugin on Android:
 * Android: into its own album "InspectorHub". WHERE that is, read from the plugin's source: its "albums path" is the app's own external
 * media folder (`getExternalMediaDirs()[0]`, /storage/emulated/0/Android/media/<package>), the album is a folder in it, and after copying
 * the file the plugin sends the (deprecated) media-scanner broadcast. It is NOT Pictures/InspectorHub.
 * Measured with that plugin on a Huawei ALP-AL00, Android 10 (2026-11-02): the photo is in the system media index at once (bucket "InspectorHub") and the
 * phone's gallery lists it as the album "InspectorHub" (under "Other albums" in Huawei's gallery); a normal UNINSTALL of the app deletes the
 * folder and the copies with it (the index keeps stale rows for files that are gone). So on Android the copy outlives signing out and
 * clearing local data, NOT uninstalling the app. Other Android versions and makers are not measured.
 * No storage permission is requested for an album the app owns. The album is looked up by name AND by the albums path with a separator, so
 * another app's folder of the same name (or a sibling package whose name starts with ours) is not taken for ours. It is created on first
 * use; two photos saved at once share one lookup; the remembered album is forgotten after a failure.
 *
 * iOS: no album, so the photo goes to Recents and the system asks for the "add only" permission, not for access to the whole library.
 */
export function createCapacitorGallery(options: CapacitorGalleryOptions): PhotoGallery {
  const { platform, media, fileSharer } = options;
  /** Looked up once, at the first save, and kept: it cannot change while the app runs. */
  let useMediaStore: Promise<boolean> | undefined;
  function shouldUseMediaStore(): Promise<boolean> {
    if (platform !== 'android' || fileSharer === undefined) return Promise.resolve(false);
    useMediaStore ??= (async () => {
      const wanted = options.androidMajor;
      const major = typeof wanted === 'function' ? await wanted().catch(() => null) : (wanted ?? null);
      return (major ?? 0) >= MEDIASTORE_MIN_ANDROID;
    })();
    return useMediaStore;
  }
  let album: Promise<string> | undefined;

  async function find(): Promise<string | undefined> {
    const [{ albums }, { path }] = await Promise.all([media.getAlbums(), media.getAlbumsPath()]);
    const root = path.endsWith('/') ? path : `${path}/`;
    return albums.find((candidate) => candidate.name === GALLERY_ALBUM_NAME && candidate.identifier.startsWith(root))?.identifier;
  }

  async function resolveAlbum(): Promise<string> {
    const existing = await find();
    if (existing !== undefined) return existing;
    try {
      await media.createAlbum({ name: GALLERY_ALBUM_NAME });
    } catch (error) {
      // Created in the meantime (by the person, or by another save): look again before giving up.
      const created = await find();
      if (created !== undefined) return created;
      throw error;
    }
    const created = await find();
    if (created === undefined) throw new Error('the album was created but not found');
    return created;
  }

  /** One lookup shared by every save that starts before it has finished. A failed lookup is not remembered. */
  function androidAlbum(): Promise<string> {
    if (album === undefined) {
      const pending = resolveAlbum();
      album = pending;
      pending.catch(() => {
        if (album === pending) album = undefined;
      });
    }
    return album;
  }

  /** One try: the album, then the photo. */
  async function attempt(dataUrl: string, name: string): Promise<void> {
    if (platform === 'android') {
      await media.savePhoto({ path: dataUrl, albumIdentifier: await androidAlbum(), fileName: albumFileName(name) });
    } else {
      await media.savePhoto({ path: dataUrl });
    }
  }

  /** The shared Pictures/InspectorHub folder through MediaStore. Rejects when the plugin is not in this build (UNIMPLEMENTED). */
  async function saveToPictures(base64: string, contentType: string, name: string): Promise<void> {
    await fileSharer?.save({
      filename: safeFileName(name),
      base64Data: base64,
      contentType,
      android: { saveDirectory: 'pictures', relativePath: `Pictures/${GALLERY_ALBUM_NAME}` },
    });
  }

  return {
    available: () => true,
    async save(blob, info): Promise<GallerySaveResult> {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const base64 = bytesToBase64(bytes);
        const contentType = blob.type || 'image/jpeg';
        // Built only where it is used: the whole photo again as a string is a lot of memory for a path that does not need it.
        const dataUrl = (): string => `data:${contentType};base64,${base64}`;
        if (await shouldUseMediaStore()) {
          try {
            await saveToPictures(base64, contentType, info.name);
            return 'saved';
          } catch (error) {
            // A build without the plugin (it says UNIMPLEMENTED) still saves, through the media plugin. Any other failure is the answer:
            // trying a second place could leave two copies.
            if ((error as { code?: unknown } | null)?.code !== 'UNIMPLEMENTED') throw error;
          }
        }
        try {
          await attempt(dataUrl(), info.name);
        } catch (error) {
          // Seen on a phone (Huawei, Android 10): the system's media index still listed the album after its folder was deleted, so the
          // plugin handed back that folder's path and then refused it: "Album identifier does not exist". The folder is made again and
          // the photo is tried once more. Any other failure, or a second one, is the answer.
          if (platform !== 'android' || !ALBUM_GONE.test(messageOf(error))) throw error;
          album = undefined;
          await media.createAlbum({ name: GALLERY_ALBUM_NAME }).catch(() => undefined);
          await attempt(dataUrl(), info.name);
        }
        return 'saved';
      } catch (error) {
        // The remembered album may have been deleted by the person since: look it up again next time.
        album = undefined;
        return refused(error) ? 'denied' : 'failed';
      }
    },
  };
}

/** The real plugin, on a phone. In a browser (development) nothing can be saved, and nothing offers to. */
export function createRealGallery(): PhotoGallery | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return null;
  return createCapacitorGallery({ platform, media: Media, fileSharer: FileSharer, androidMajor: () => androidMajorFromNavigator(navigator as unknown as NavigatorLike) });
}
