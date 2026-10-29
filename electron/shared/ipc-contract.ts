/**
 * The desktop client's one privileged interface. The renderer sees it as `window.oiDesktop`; the main process answers
 * each method on the channel named in `CHANNELS`. This module is types, names and pure checks only, so the main
 * process, the preload script and the renderer can all read it.
 */
export type DbParam = string | number | null | Uint8Array;
export type DbRow = Record<string, string | number | null | Uint8Array>;
export type OpenReason = 'key-unreadable' | 'encryption-unavailable' | 'schema-too-new' | 'schema-drift' | 'corrupt' | 'io';

export type UpdaterState =
  | { kind: 'disabled'; reason: 'unsigned' | 'dev' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; code: 'network' | 'verify' | 'other' };

/** The options of an upload the main process runs; the same shape as the Capacitor uploader's, minus what only Android reads. */
export interface UploaderStartOptions {
  /** `file://` uri of the file to send. */
  filePath: string;
  serverUrl: string;
  method: 'POST';
  uploadType: 'multipart';
  fileField: string;
  mimeType: string;
  maxRetries: number;
  headers: Record<string, string>;
  notificationTitle: string;
}

export interface UploaderEventLike {
  name: string;
  id: string;
  eventId?: string;
  payload?: { percent?: number; statusCode?: number; error?: string };
}

export interface FileEntryLike {
  name: string;
  mtimeMs: number | null;
}

/** Every path is relative; the main process joins it to a fixed root and refuses anything that escapes it. */
export interface FilesBridge {
  write(path: string, data: Uint8Array): Promise<string>;
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  displayUrl(path: string): Promise<string>;
  fileUri(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  list(directoryPath: string): Promise<FileEntryLike[]>;
  removeCache(path: string): Promise<void>;
  listCache(): Promise<FileEntryLike[]>;
  stream: {
    open(area: 'media' | 'cache', path: string): Promise<{ handle: string }>;
    append(handle: string, chunk: Uint8Array): Promise<void>;
    finish(handle: string, outcome: 'commit' | 'abort'): Promise<string>;
  };
}

export const HEIC_DECODE_CODES = ['CODEC_MISSING', 'HELPER_MISSING', 'UNSUPPORTED', 'TOO_LARGE_PIXELS', 'CORRUPT', 'TIMEOUT'] as const;
export type HeicDecodeCode = (typeof HEIC_DECODE_CODES)[number];

export interface DecodeHeicRequest {
  bytes: ArrayBuffer;
  /** `Infinity` is allowed only together with `keepOriginal`. */
  maxLongEdge: number;
  keepOriginal?: { maxBytes: number };
}
export type DecodeHeicReply = { ok: true; jpeg: ArrayBuffer } | { ok: false; code: HeicDecodeCode };

export interface DesktopBridge {
  readonly apiVersion: 1;
  db: {
    open(): Promise<{ ok: true; schemaVersion: number } | { ok: false; reason: OpenReason }>;
    execute(sql: string): Promise<void>;
    query(sql: string, params?: DbParam[]): Promise<DbRow[]>;
    run(sql: string, params?: DbParam[]): Promise<{ changes: number; lastId?: number }>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    inTransaction(): Promise<boolean>;
    close(): Promise<void>;
    setAsideUnreadable(): Promise<void>;
  };
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
  kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  files: FilesBridge;
  uploader: {
    start(options: UploaderStartOptions): Promise<{ id: string }>;
    remove(id: string): Promise<void>;
    onEvent(listener: (event: UploaderEventLike) => void): () => void;
  };
  shell: { openExternal(url: string): Promise<void>; openLogs(): Promise<void>; openDataFolder(): Promise<void> };
  auth: { onCallback(listener: (url: string) => void): () => void };
  app: { onActiveChange(listener: (active: boolean) => void): () => void };
  dialogs: { saveExport(fileUri: string, suggestedName: string): Promise<'saved' | 'cancelled'> };
  updater: {
    state(): Promise<UpdaterState>;
    onState(listener: (state: UpdaterState) => void): () => void;
    check(): Promise<void>;
    download(): Promise<void>;
    installAndRestart(): Promise<'restarting' | 'blocked-uploads'>;
  };
  /** The one way the renderer reaches the system HEIC decoder. It cannot name an executable, a path or an argument. */
  media: { decodeHeic(request: DecodeHeicRequest): Promise<DecodeHeicReply> };
}

export type BridgeNamespace = Exclude<keyof DesktopBridge, 'apiVersion'>;

/** The methods of each namespace. A test holds this list to `DesktopBridge` in both directions. */
export const BRIDGE_METHODS = {
  db: ['open', 'execute', 'query', 'run', 'begin', 'commit', 'rollback', 'inTransaction', 'close', 'setAsideUnreadable'],
  secrets: ['get', 'set', 'remove'],
  kv: ['get', 'set'],
  files: ['write', 'size', 'read', 'remove', 'displayUrl', 'fileUri', 'exists', 'list', 'removeCache', 'listCache', 'stream'],
  uploader: ['start', 'remove', 'onEvent'],
  shell: ['openExternal', 'openLogs', 'openDataFolder'],
  auth: ['onCallback'],
  app: ['onActiveChange'],
  dialogs: ['saveExport'],
  updater: ['state', 'onState', 'check', 'download', 'installAndRestart'],
  media: ['decodeHeic'],
} as const satisfies { [N in BridgeNamespace]: readonly (keyof DesktopBridge[N])[] };

/** Request channels (`ipcRenderer.invoke` to `ipcMain.handle`). */
export const CHANNELS = {
  db: {
    open: 'db:open',
    execute: 'db:execute',
    query: 'db:query',
    run: 'db:run',
    begin: 'db:begin',
    commit: 'db:commit',
    rollback: 'db:rollback',
    inTransaction: 'db:in-transaction',
    close: 'db:close',
    setAsideUnreadable: 'db:set-aside-unreadable',
  },
  secrets: { get: 'secrets:get', set: 'secrets:set', remove: 'secrets:remove' },
  kv: { get: 'kv:get', set: 'kv:set' },
  files: {
    write: 'files:write',
    size: 'files:size',
    read: 'files:read',
    remove: 'files:remove',
    displayUrl: 'files:display-url',
    fileUri: 'files:file-uri',
    exists: 'files:exists',
    list: 'files:list',
    removeCache: 'files:remove-cache',
    listCache: 'files:list-cache',
    streamOpen: 'files:stream-open',
    streamAppend: 'files:stream-append',
    streamFinish: 'files:stream-finish',
  },
  uploader: { start: 'uploader:start', remove: 'uploader:remove' },
  shell: { openExternal: 'shell:open-external', openLogs: 'shell:open-logs', openDataFolder: 'shell:open-data-folder' },
  dialogs: { saveExport: 'dialogs:save-export' },
  updater: {
    state: 'updater:state',
    check: 'updater:check',
    download: 'updater:download',
    installAndRestart: 'updater:install-and-restart',
  },
  media: { decodeHeic: 'media:decode-heic' },
} as const;

/** Event channels (`webContents.send` to a preload listener). The listener receives the payload and nothing else. */
export const EVENT_CHANNELS = {
  uploaderEvent: 'uploader:event',
  authCallback: 'auth:callback',
  activeChange: 'app:active-change',
  updaterState: 'updater:state-changed',
} as const;

/** Preload tells main that its appUrlOpen listener is ready to receive callbacks. */
export const AUTH_CALLBACK_READY_CHANNEL = 'auth:ready';

/** The only error codes that cross the boundary. A message, a stack or a path never does. */
export const IPC_ERROR_CODES = ['invalid-argument', 'untrusted-sender', 'not-found', 'disk-full', 'unavailable', 'internal'] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/** What a handler throws to report one of the closed codes; any other error reaches the renderer as `internal`. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode) {
    super(code);
    this.name = 'IpcError';
    this.code = code;
  }
}

export type IpcEnvelope = { ok: true; value: unknown } | { ok: false; code: IpcErrorCode };

export const isIpcErrorCode = (value: unknown): value is IpcErrorCode => (IPC_ERROR_CODES as readonly unknown[]).includes(value);

const isArrayBuffer = (value: unknown): value is ArrayBuffer => Object.prototype.toString.call(value) === '[object ArrayBuffer]';

/** The renderer-side check of a decode reply: a closed shape, a closed code, a real buffer. */
export function isDecodeHeicReply(value: unknown): value is DecodeHeicReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply);
  if (reply.ok === true) return keys.length === 2 && isArrayBuffer(reply.jpeg);
  if (reply.ok === false) return keys.length === 2 && (HEIC_DECODE_CODES as readonly unknown[]).includes(reply.code);
  return false;
}
