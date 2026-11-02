import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { OpenReason } from '../../electron/shared/ipc-contract.ts';
import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import { DbKeyLost, OpenFailed } from '../../src/ui/Blocking';
import '../../src/styles.css';

declare global { interface Window { __actions: string[] } }

const params = new URLSearchParams(location.search);
const reason = params.get('reason') as OpenReason | null;
document.documentElement.dataset.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
window.__actions = [];
window.oiDesktop = {
  apiVersion: 1,
  db: { setAsideUnreadable: () => { window.__actions.push('set-aside'); return new Promise<void>(() => undefined); } },
  shell: { openDataFolder: async () => { window.__actions.push('open-data-folder'); } },
} as unknown as DesktopBridge;

// `?screen=db-key-lost` shows the screen for a database whose key is gone (Android and iOS; it has no controls).
createRoot(document.getElementById('root')!).render(<StrictMode>{params.get('screen') === 'db-key-lost' ? <DbKeyLost /> : <OpenFailed reason={reason ?? 'io'} />}</StrictMode>);
