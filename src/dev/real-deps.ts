import { Directory, Filesystem } from '@capacitor/filesystem';
import { realTimers } from '../collab/timers';
import { createRealNetwork } from '../platform/network-capacitor';
import { createRealUploaderPlugin } from '../platform/uploader-capacitor';
import { errorWord, type DiagDeps, type DiagPorts, type SocketProbe } from './checks/types';

function loadImage(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    image.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    image.src = url;
  });
}

function probeSocket(url: string, waitMs: number): Promise<SocketProbe> {
  return new Promise((resolve) => {
    let opened = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      resolve({ opened: false, closeCode: null, threw: errorWord(error) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve({ opened, closeCode: null, threw: null });
    }, waitMs);
    socket.onopen = () => {
      opened = true;
      socket.close(1000);
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve({ opened, closeCode: event.code, threw: null });
    };
  });
}

const ports: DiagPorts = {
  statMissing: async (path) => {
    try {
      await Filesystem.stat({ path, directory: Directory.LibraryNoCloud });
      return null;
    } catch (error) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return { code: typeof code === 'string' ? code : null, message: typeof message === 'string' ? message : '' };
    }
  },
  loadImage,
  storageEstimate: async () => {
    if (typeof navigator === 'undefined' || !('storage' in navigator)) return null;
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null };
  },
  notificationPermission: () => (typeof Notification === 'undefined' ? 'unknown' : Notification.permission),
  probeSocket,
  timers: realTimers,
  random: () => Math.random(),
};

/** The device's own adapters: the real plugins, the real network, the real WebSocket. */
export function createRealDiagDeps(): DiagDeps {
  return { ports, uploaderPlugin: createRealUploaderPlugin(), network: createRealNetwork() };
}
