import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * The notification shade while uploads run. The upload plugin posts one "Completed" notification per file and leaves it there; this
 * port asks the app's own native layer to remove those, so the shade holds the one ongoing notice and nothing after the run.
 */
export interface UploadShadePort {
  /** Removes the finished-upload notifications now and again shortly after (the plugin may post one just after its event). Never rejects meaningfully: callers ignore a failure. */
  tidy(): Promise<void>;
}

interface UploadShadeNative {
  tidy(): Promise<void>;
}

const NOTHING: UploadShadePort = { tidy: () => Promise.resolve() };

/** Android only: the other platforms have no such notifications to remove. */
export function createRealUploadShade(): UploadShadePort {
  if (Capacitor.getPlatform() !== 'android') return NOTHING;
  const native = registerPlugin<UploadShadeNative>('UploadShade');
  return { tidy: () => native.tidy() };
}
