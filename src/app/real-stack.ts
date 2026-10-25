import { realSocketFactory } from '../collab/real';
import { realTimers } from '../collab/timers';
import type { AppStatePort } from '../offline/lock-monitor';
import { createRealNetwork } from '../platform/network';
import { createRealUploaderPlugin } from '../platform/uploader';
import { appDiagnostics } from './diagnostics';
import { createOfflineStack } from './offline-stack';
import { appTimings } from './timings';
import type { StackFactory } from './use-offline-stack';

/**
 * The device's adapters behind the stack: the Capacitor network and uploader plugins, the page's WebSocket and timers.
 * The origin and the identity come from the signed-in screen, which read them from the stored server url and identity.
 */
export function createRealStackFactory(options: { appState: AppStatePort }): StackFactory {
  const network = createRealNetwork();
  const uploaderPlugin = createRealUploaderPlugin();
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
      openSocket: realSocketFactory,
      allowInsecureHttp,
      timers: realTimers,
      onUnlocked,
      onTokenVerified: services.onTokenVerified,
      // The latest fixed codes stay in memory for a settings screen; they never leave the device and carry no id, path or url.
      onDiagnostic: appDiagnostics.push,
      // The list's first paint comes before the sweeps, replay, reconcile and refresh begin: they would queue its reads behind them.
      deferLaunchUntilPainted: true,
      onTiming: appTimings.record,
    });
}
