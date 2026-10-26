import { Uploader } from '@capgo/capacitor-uploader';
import type { UploaderPluginLike } from './uploader';

/** Thin real-plugin wiring. The notification shade is handled natively (`UploadShade.java`): one rate-limited notice, nothing per file. */
export function createRealUploaderPlugin(): UploaderPluginLike {
  return {
    startUpload: (options) => Uploader.startUpload(options),
    removeUpload: (options) => Uploader.removeUpload(options),
    addListener: (name, listener) => Uploader.addListener(name, (event) => listener(event)),
    acknowledgeEvent: (options) => Uploader.acknowledgeEvent(options),
  };
}
