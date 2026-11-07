import { StrictMode } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor, SystemBars } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerCallbackRouter } from './app/callbacks';
import { composeReal, createRealStackFactory } from './app/compose-capacitor';
import { createCapacitorAppState } from './offline/lock-monitor';
import { createRealHaptics } from './platform/haptics-capacitor';
import { setHapticsPort } from './platform/haptics';
import { createRealNetwork } from './platform/network-capacitor';
import './styles.css';
import { registerBackButton } from './ui/back-button';
import { followSystemColorScheme } from './ui/color-scheme';
import { followKeyboardInset } from './ui/keyboard-inset';
import { createSystemBarsSync } from './ui/system-bars';

setHapticsPort(createRealHaptics());
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

followSystemColorScheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'), createSystemBarsSync(SystemBars));

// iOS only: the keyboard covers the web view there (capacitor.config.ts), so the page grows by its height to stay scrollable.
if (Capacitor.getPlatform() === 'ios') followKeyboardInset(document.documentElement, Keyboard);

// Registered at start, before the database opens, so a callback that arrives early finds a listener.
const callbacks = registerCallbackRouter(CapacitorApp);
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
