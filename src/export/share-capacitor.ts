import { Share } from '@capacitor/share';
import type { Sharer } from './share-package';

/** The sheet's title; no customer data. */
const SHEET_TITLE = 'Export unsent data';

export function createRealSharer(): Sharer {
  return {
    share: async (uri) => {
      await Share.share({ title: SHEET_TITLE, dialogTitle: SHEET_TITLE, files: [uri] });
    },
  };
}
