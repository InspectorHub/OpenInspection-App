import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerCallbackRouter } from './app/callbacks';
import { getDesktopBridge } from './desktop/bridge';
import { composeDesktop } from './desktop/compose-desktop';
import { createDesktopAppState } from './desktop/app-state-desktop';
import { createDesktopStackFactory } from './desktop/stack-desktop';
import { createDesktopDiagDeps } from './desktop/diag-deps-desktop';
import type { DesktopSettingsPort } from './desktop/updater-port';
import type { UpdaterState } from '../electron/shared/ipc-contract';
import { createDesktopAppLike } from './desktop/auth-session-desktop';
import { followSystemColorScheme } from './ui/color-scheme';
import './styles.css';

const bridge = getDesktopBridge();
const callbacks = registerCallbackRouter(createDesktopAppLike(bridge));
const appState = createDesktopAppState(bridge);
const offline = createDesktopStackFactory({ bridge, appState });
const diagnostics = createDesktopDiagDeps(bridge);
const openDesktopServices = () => composeDesktop(bridge);
followSystemColorScheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'));

// Disk imports use the native file chooser. Cancel Chromium's default file-drop
// navigation so dropping a file cannot replace the app renderer document.
const preventFileDropNavigation = (event: DragEvent): void => event.preventDefault();
document.addEventListener('dragover', preventFileDropNavigation);
document.addEventListener('drop', preventFileDropNavigation);

function DesktopRenderer() {
  const [updater, setUpdater] = useState<UpdaterState>({ kind: 'disabled', reason: 'dev' });
  useEffect(() => {
    let live = true;
    void bridge.updater.state().then((state) => { if (live) setUpdater(state); }).catch(() => {
      // Task 13 adds the main-process updater host; before it exists, keep the deliberate disabled state.
      if (live) setUpdater({ kind: 'disabled', reason: 'dev' });
    });
    const remove = bridge.updater.onState(setUpdater);
    return () => { live = false; remove(); };
  }, []);
  const desktop = useMemo<DesktopSettingsPort>(() => ({
    appVersion: __APP_VERSION__, updater,
    checkForUpdates: () => { void bridge.updater.check(); },
    openLogs: () => { void bridge.shell.openLogs(); },
    openDataFolder: () => { void bridge.shell.openDataFolder(); },
  }), [updater]);
  return <App open={openDesktopServices} callbacks={callbacks} appState={appState} offline={offline} desktopSettings={desktop} diagnostics={diagnostics} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(<StrictMode><DesktopRenderer /></StrictMode>);
