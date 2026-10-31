import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import { realSocketFactory } from '../collab/real';
import type { AppStatePort } from '../offline/lock-monitor';
import { createBrowserNetwork } from './network-browser';
import { createDesktopUploaderPlugin } from './uploader-ipc';
import { createStackFactory } from '../app/real-stack';
import type { StackFactory } from '../app/use-offline-stack';

export function createDesktopStackFactory(o: { bridge: DesktopBridge; appState: AppStatePort }): StackFactory {
  return createStackFactory({
    network: createBrowserNetwork(window),
    uploaderPlugin: createDesktopUploaderPlugin(o.bridge),
    socketFactory: realSocketFactory,
  }, { appState: o.appState });
}
