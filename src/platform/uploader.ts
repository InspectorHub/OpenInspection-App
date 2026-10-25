import { Uploader } from '@capgo/capacitor-uploader';
import { createRealUploadShade, type UploadShadePort } from './upload-shade';

/** The options of `startUpload` that this app uses; a subset of the plugin's. */
export interface UploaderStartOptions {
  /** `file://` uri of the file to send. */
  filePath: string;
  serverUrl: string;
  method: 'POST';
  uploadType: 'multipart';
  fileField: string;
  /** Sent as the content type of the file part; the plugin guesses from the extension otherwise, and `.heic` is not reliably known. */
  mimeType: string;
  maxRetries: number;
  headers: Record<string, string>;
  /** Android only: the title of the foreground-service notification. */
  notificationTitle: string;
}

/**
 * What the plugin emits on `events`. Every field is optional here because the listener validates the
 * shape itself: an event is data from another process, and the plugin also emits names its typings omit.
 */
export interface UploaderEventLike {
  name: string;
  id: string;
  eventId?: string;
  payload?: { percent?: number; statusCode?: number; error?: string };
}

/** The part of the plugin the upload code uses. */
export interface UploaderPluginLike {
  startUpload(options: UploaderStartOptions): Promise<{ id: string }>;
  removeUpload(options: { id: string }): Promise<void>;
  addListener(name: 'events', listener: (event: UploaderEventLike) => void): Promise<{ remove(): Promise<void> }>;
  /** Removes a delivered `completed`/`failed` event from the plugin's persistent cache (Android; a no-op on iOS). */
  acknowledgeEvent(options: { eventId: string }): Promise<void>;
}

/**
 * Keeps the shade to the one ongoing notice. The plugin's notification texts and per-file "Completed" notifications are fixed in
 * its native code, so the app removes the finished ones itself: once when the listener attaches (leftovers of an earlier run) and
 * after each terminal event has reached the app. A failing shade never touches the upload events.
 */
export function withQuietShade(plugin: UploaderPluginLike, shade: UploadShadePort): UploaderPluginLike {
  const tidy = (): void => {
    shade.tidy().catch(() => undefined);
  };
  return {
    ...plugin,
    addListener: async (name, listener) => {
      const handle = await plugin.addListener(name, (event) => {
        listener(event);
        if (event.name === 'completed' || event.name === 'failed') tidy();
      });
      tidy();
      return handle;
    },
  };
}

/** Thin real-plugin wiring. */
export function createRealUploaderPlugin(): UploaderPluginLike {
  return withQuietShade(
    {
      startUpload: (options) => Uploader.startUpload(options),
      removeUpload: (options) => Uploader.removeUpload(options),
      addListener: (name, listener) => Uploader.addListener(name, (event) => listener(event)),
      acknowledgeEvent: (options) => Uploader.acknowledgeEvent(options),
    },
    createRealUploadShade(),
  );
}
