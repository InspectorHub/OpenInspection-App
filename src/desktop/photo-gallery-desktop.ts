import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { GallerySaveResult, PhotoGallery } from '../platform/photo-gallery';

/**
 * The InspectorHub folder of the system Pictures folder (Windows and macOS alike), through the desktop bridge. Saving is best effort and never throws. The main process picks the folder
 * and checks the name; here a photo is only turned into bytes. The bridge reports a refused write (no access to the folder) as
 * 'unavailable' and everything else, a full disk included, as another closed code: only the first is a permission the person can fix.
 */
export function createDesktopGallery(bridge: Pick<DesktopBridge, 'gallery'>): PhotoGallery {
  return {
    available: () => true,
    async save(blob, info): Promise<GallerySaveResult> {
      try {
        await bridge.gallery.save(info.name, new Uint8Array(await blob.arrayBuffer()));
        return 'saved';
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
        return code === 'unavailable' ? 'denied' : 'failed';
      }
    },
  };
}
