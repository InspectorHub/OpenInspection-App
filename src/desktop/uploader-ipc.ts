import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { UploaderPluginLike } from '../platform/uploader.ts';

export function createDesktopUploaderPlugin(bridge: Pick<DesktopBridge, 'uploader'>): UploaderPluginLike {
  return {
    startUpload: (options) => bridge.uploader.start({
      ...options,
      headers: Object.fromEntries(Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), value])),
    }),
    removeUpload: ({ id }) => bridge.uploader.remove(id),
    addListener: async (name, listener) => {
      if (name !== 'events') throw new Error('unsupported-event');
      const remove = bridge.uploader.onEvent(listener);
      return { remove: async () => { remove(); } };
    },
    acknowledgeEvent: async () => undefined,
  };
}
