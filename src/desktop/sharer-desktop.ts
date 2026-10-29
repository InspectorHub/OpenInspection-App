import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { Sharer } from '../export/share-package.ts';

function suggestedName(uri: string): string {
  try {
    const leaf = new URL(uri).pathname.split('/').at(-1) ?? '';
    return decodeURIComponent(leaf);
  } catch {
    return '';
  }
}

export function createDesktopSharer(bridge: Pick<DesktopBridge, 'dialogs'>): Sharer {
  return {
    async share(uri) {
      const result = await bridge.dialogs.saveExport(uri, suggestedName(uri));
      if (result === 'cancelled') throw new Error('Share canceled');
    },
  };
}
