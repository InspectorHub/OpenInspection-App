/**
 * The phone's photo library (or, on a computer, a pictures folder) as a place to put a COPY of a photo the person took in the
 * app. Saving is best effort and never throws: every outcome is a value. The app never deletes what it saves here.
 */
export type GallerySaveResult = 'saved' | 'denied' | 'failed';

export interface PhotoGallery {
  /** True only where this build has a working way to save (an adapter exists and the platform allows it). Controls that need it stay hidden otherwise. */
  available(): boolean;
  save(blob: Blob, info: { name: string; createdAt: number }): Promise<GallerySaveResult>;
}

/** Used until a platform adapter exists: nothing can be saved, and nothing offers to. */
export const unavailableGallery: PhotoGallery = {
  available: () => false,
  save: () => Promise.resolve('failed'),
};

/** An in-memory gallery for tests. */
export function createMemoryGallery(options: { available?: boolean; result?: GallerySaveResult } = {}): PhotoGallery & {
  saved: Array<{ name: string; createdAt: number; size: number; type: string }>;
  result: GallerySaveResult;
} {
  const gallery = {
    saved: [] as Array<{ name: string; createdAt: number; size: number; type: string }>,
    result: options.result ?? 'saved',
    available: () => options.available ?? true,
    save: (blob: Blob, info: { name: string; createdAt: number }): Promise<GallerySaveResult> => {
      if (gallery.result === 'saved') gallery.saved.push({ name: info.name, createdAt: info.createdAt, size: blob.size, type: blob.type });
      return Promise.resolve(gallery.result);
    },
  };
  return gallery;
}
