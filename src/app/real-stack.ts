import type { SocketFactory } from '../collab/connector';
import { realTimers } from '../collab/timers';
import { editorRegistry } from '../field/editor-registry';
import type { AppStatePort } from '../offline/lock-monitor';
import type { Network } from '../platform/network';
import type { UploaderPluginLike } from '../platform/uploader';
import { factsFor, serverTooOldFor } from './client-state';
import type { AppServices } from './compose';
import { appDiagnostics } from './diagnostics';
import { createOfflineStack, type OfflineStackDeps } from './offline-stack';
import { appTimings } from './timings';
import type { StackFactory } from './use-offline-stack';

/** The longest the look at the server's contract may hold the first sync back. It runs only while online. */
export const LAUNCH_COMPAT_TIMEOUT_MS = 5_000;

/** How the stack learns whether the server is too old: the state of this server, and one look at it before the first flow. */
export function contractPorts(
  services: Pick<AppServices, 'clientState' | 'refreshCompat'>,
  origin: string,
): Pick<OfflineStackDeps, 'serverTooOld' | 'beforeLaunch' | 'compatKnown' | 'reconcileSupported' | 'onReconcileUnsupported'> {
  const facts = () => factsFor(services.clientState.store.get(), origin);
  return {
    serverTooOld: serverTooOldFor(services.clientState, origin),
    beforeLaunch: () => services.refreshCompat(origin, { timeoutMs: LAUNCH_COMPAT_TIMEOUT_MS }),
    compatKnown: () => facts().compatKnown,
    reconcileSupported: () => facts().reconcileSupported,
    onReconcileUnsupported: () => services.clientState.noteReconcileUnsupported(origin),
  };
}

/** The platform adapters the offline stack needs besides the services: what differs between the Android, iOS and desktop clients. */
export interface StackAdapters {
  network: Network;
  uploaderPlugin: UploaderPluginLike;
  socketFactory: SocketFactory;
}

/**
 * The platform's adapters behind the stack, with the page's timers. The origin and the identity come from the signed-in
 * screen, which read them from the stored server url and identity.
 */
export function createStackFactory(adapters: StackAdapters, options: { appState: AppStatePort }): StackFactory {
  const { network, uploaderPlugin, socketFactory } = adapters;
  return ({ services, origin, identity, allowInsecureHttp, onUnlocked }) =>
    createOfflineStack({
      db: services.db,
      files: services.files,
      http: services.http,
      tokens: services.tokens,
      origin,
      identity,
      clientHeaders: { 'X-Client-Platform': services.platform, 'X-Client-Version': services.appVersion },
      clock: services.clock,
      network,
      appState: options.appState,
      uploaderPlugin,
      openSocket: socketFactory,
      allowInsecureHttp,
      timers: realTimers,
      onUnlocked,
      onTokenVerified: services.onTokenVerified,
      ...contractPorts(services, origin),
      // The latest fixed codes stay in memory for a settings screen; they never leave the device and carry no id, path or url.
      onDiagnostic: appDiagnostics.push,
      // The list's first paint comes before the sweeps, replay, reconcile and refresh begin: they would queue its reads behind them.
      deferLaunchUntilPainted: true,
      onTiming: appTimings.record,
      // The stack asks the editor whether an inspection is open and for its live document.
      editor: editorRegistry,
    });
}
