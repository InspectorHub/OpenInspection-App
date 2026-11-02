import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import { realTimers } from '../collab/timers';
import { createBrowserNetwork } from './network-browser';
import { createDesktopUploaderPlugin } from './uploader-ipc';
import { errorWord, type DiagDeps, type DiagPorts, type SocketProbe } from '../dev/checks/types';

function probeSocket(url: string, waitMs: number): Promise<SocketProbe> {
  return new Promise((resolve) => {
    let opened = false;
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch (error) { resolve({ opened: false, closeCode: null, threw: errorWord(error) }); return; }
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* Already closing. */ }
      resolve({ opened, closeCode: null, threw: null });
    }, waitMs);
    socket.onopen = () => { opened = true; socket.close(1000); };
    socket.onclose = (event) => { clearTimeout(timer); resolve({ opened, closeCode: event.code, threw: null }); };
  });
}

function loadImage(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    image.onload = () => { clearTimeout(timer); resolve(true); };
    image.onerror = () => { clearTimeout(timer); resolve(false); };
    image.src = url;
  });
}

export function createDesktopDiagDeps(bridge: DesktopBridge): DiagDeps {
  const ports: DiagPorts = {
    statMissing: async (path) => {
      try { return await bridge.files.exists(path) ? null : { code: 'NotFound', message: 'File not found' }; }
      catch (error) { return { code: errorWord(error), message: 'File check failed' }; }
    },
    loadImage,
    storageEstimate: async () => {
      if (!('storage' in navigator)) return null;
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
    },
    notificationPermission: () => typeof Notification === 'undefined' ? 'unknown' : Notification.permission,
    probeSocket,
    timers: realTimers,
    random: () => Math.random(),
  };
  return { ports, uploaderPlugin: createDesktopUploaderPlugin(bridge), network: createBrowserNetwork(window) };
}
