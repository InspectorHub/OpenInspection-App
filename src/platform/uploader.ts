import { Uploader } from '@capgo/capacitor-uploader';

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

/** Thin real-plugin wiring. The notification shade is handled natively (`UploadShade.java`): one rate-limited notice, nothing per file. */
export function createRealUploaderPlugin(): UploaderPluginLike {
  return {
    startUpload: (options) => Uploader.startUpload(options),
    removeUpload: (options) => Uploader.removeUpload(options),
    addListener: (name, listener) => Uploader.addListener(name, (event) => listener(event)),
    acknowledgeEvent: (options) => Uploader.acknowledgeEvent(options),
  };
}
