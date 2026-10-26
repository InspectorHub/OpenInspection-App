import { contextBridge, ipcRenderer } from 'electron';
import {
  CHANNELS,
  EVENT_CHANNELS,
  IpcError,
  isDecodeHeicReply,
  isIpcErrorCode,
  type DesktopBridge,
} from '../shared/ipc-contract.ts';

/** Sends one request and unwraps the reply. A failure surfaces as an `IpcError` whose message is a closed code. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  let reply: unknown;
  try {
    reply = await ipcRenderer.invoke(channel, ...args);
  } catch {
    // Electron words a rejection as "Error invoking remote method ...: <the original message>", which can carry a path.
    throw new IpcError('internal');
  }
  if (typeof reply === 'object' && reply !== null) {
    const envelope = reply as { ok?: unknown; value?: unknown; code?: unknown };
    if (envelope.ok === true) return envelope.value as T;
    if (envelope.ok === false) throw new IpcError(isIpcErrorCode(envelope.code) ? envelope.code : 'internal');
  }
  throw new IpcError('internal');
}

/** Subscribes to an event channel; the listener receives the payload only, never the event object. */
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

/** An omitted optional argument is left out, not sent as `undefined`. */
const optional = (value: unknown): unknown[] => (value === undefined ? [] : [value]);

const bridge: DesktopBridge = {
  apiVersion: 1,
  db: {
    open: () => call(CHANNELS.db.open),
    execute: (sql) => call(CHANNELS.db.execute, sql),
    query: (sql, params) => call(CHANNELS.db.query, sql, ...optional(params)),
    run: (sql, params) => call(CHANNELS.db.run, sql, ...optional(params)),
    begin: () => call(CHANNELS.db.begin),
    commit: () => call(CHANNELS.db.commit),
    rollback: () => call(CHANNELS.db.rollback),
    inTransaction: () => call(CHANNELS.db.inTransaction),
    close: () => call(CHANNELS.db.close),
    setAsideUnreadable: () => call(CHANNELS.db.setAsideUnreadable),
  },
  secrets: {
    get: (key) => call(CHANNELS.secrets.get, key),
    set: (key, value) => call(CHANNELS.secrets.set, key, value),
    remove: (key) => call(CHANNELS.secrets.remove, key),
  },
  kv: {
    get: (key) => call(CHANNELS.kv.get, key),
    set: (key, value) => call(CHANNELS.kv.set, key, value),
  },
  files: {
    write: (path, data) => call(CHANNELS.files.write, path, data),
    size: (path) => call(CHANNELS.files.size, path),
    read: (path) => call(CHANNELS.files.read, path),
    remove: (path) => call(CHANNELS.files.remove, path),
    displayUrl: (path) => call(CHANNELS.files.displayUrl, path),
    fileUri: (path) => call(CHANNELS.files.fileUri, path),
    exists: (path) => call(CHANNELS.files.exists, path),
    list: (directoryPath) => call(CHANNELS.files.list, directoryPath),
    removeCache: (path) => call(CHANNELS.files.removeCache, path),
    listCache: () => call(CHANNELS.files.listCache),
    stream: {
      open: (area, path) => call(CHANNELS.files.streamOpen, area, path),
      append: (handle, chunk) => call(CHANNELS.files.streamAppend, handle, chunk),
      finish: (handle, outcome) => call(CHANNELS.files.streamFinish, handle, outcome),
    },
  },
  uploader: {
    start: (options) => call(CHANNELS.uploader.start, options),
    remove: (id) => call(CHANNELS.uploader.remove, id),
    onEvent: (listener) => listen(EVENT_CHANNELS.uploaderEvent, listener),
  },
  shell: {
    openExternal: (url) => call(CHANNELS.shell.openExternal, url),
    openLogs: () => call(CHANNELS.shell.openLogs),
    openDataFolder: () => call(CHANNELS.shell.openDataFolder),
  },
  auth: { onCallback: (listener) => listen(EVENT_CHANNELS.authCallback, listener) },
  app: { onActiveChange: (listener) => listen(EVENT_CHANNELS.activeChange, listener) },
  dialogs: { saveExport: (fileUri, suggestedName) => call(CHANNELS.dialogs.saveExport, fileUri, suggestedName) },
  updater: {
    state: () => call(CHANNELS.updater.state),
    onState: (listener) => listen(EVENT_CHANNELS.updaterState, listener),
    check: () => call(CHANNELS.updater.check),
    download: () => call(CHANNELS.updater.download),
    installAndRestart: () => call(CHANNELS.updater.installAndRestart),
  },
  media: {
    decodeHeic: async (request) => {
      const reply = await call<unknown>(CHANNELS.media.decodeHeic, request);
      if (!isDecodeHeicReply(reply)) throw new IpcError('internal');
      return reply;
    },
  },
};

contextBridge.exposeInMainWorld('oiDesktop', bridge);
