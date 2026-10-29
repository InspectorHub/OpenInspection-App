import { StrictMode } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { SystemBars } from '@capacitor/core';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerCallbackRouter } from './app/callbacks';
import { createDesktopAppLike } from './desktop/auth-session-desktop';
import { getDesktopBridge } from './desktop/bridge';
import { composeReal, createRealStackFactory } from './app/compose-capacitor';
import { createCapacitorAppState } from './offline/lock-monitor';
import { createRealHaptics } from './platform/haptics-capacitor';
import { setHapticsPort } from './platform/haptics';
import { createRealNetwork } from './platform/network-capacitor';
import './styles.css';
import { registerBackButton } from './ui/back-button';
import { followSystemColorScheme } from './ui/color-scheme';
import { createSystemBarsSync } from './ui/system-bars';

setHapticsPort(createRealHaptics());
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

followSystemColorScheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'), createSystemBarsSync(SystemBars));

// Registered at start, before the database opens, so a callback that arrives early finds a listener.
const desktopBridge = typeof window !== 'undefined' && window.oiDesktop ? getDesktopBridge() : null;
const callbacks = registerCallbackRouter(desktopBridge ? createDesktopAppLike(desktopBridge) : CapacitorApp);
// One back-key listener for the whole app: without it the system back key leaves the app from any screen.
registerBackButton(CapacitorApp);
const appState = createCapacitorAppState(CapacitorApp);
const offlineStack = createRealStackFactory({ appState });
const network = createRealNetwork();

createRoot(root).render(
  <StrictMode>
    <App open={composeReal} callbacks={callbacks} appState={appState} offline={offlineStack} network={network} />
  </StrictMode>,
);
