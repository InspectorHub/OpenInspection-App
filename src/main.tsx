import { StrictMode } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { SystemBars } from '@capacitor/core';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerCallbackRouter } from './app/callbacks';
import { composeReal } from './app/compose';
import { createRealStackFactory } from './app/real-stack';
import { createCapacitorAppState } from './offline/lock-monitor';
import './styles.css';
import { followSystemColorScheme } from './ui/color-scheme';
import { createSystemBarsSync } from './ui/system-bars';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

followSystemColorScheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'), createSystemBarsSync(SystemBars));

// Registered at start, before the database opens, so a callback that arrives early finds a listener.
const callbacks = registerCallbackRouter(CapacitorApp);
const appState = createCapacitorAppState(CapacitorApp);
const offlineStack = createRealStackFactory({ appState });

createRoot(root).render(
  <StrictMode>
    <App open={composeReal} callbacks={callbacks} appState={appState} offline={offlineStack} />
  </StrictMode>,
);
