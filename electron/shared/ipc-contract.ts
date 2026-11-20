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

export const HEIC_DECODE_CODES = ['CODEC_MISSING', 'HELPER_MISSING', 'UNSUPPORTED', 'TOO_LARGE_PIXELS', 'TOO_LARGE_BYTES', 'CORRUPT', 'TIMEOUT'] as const;
export type HeicDecodeCode = (typeof HEIC_DECODE_CODES)[number];

export interface DecodeHeicRequest {
  bytes: ArrayBuffer;
  /** `Infinity` is allowed only together with `keepOriginal`. */
  maxLongEdge: number;
  keepOriginal?: { maxBytes: number };
}
export type DecodeHeicReply = { ok: true; jpeg: Uint8Array } | { ok: false; code: HeicDecodeCode };

/** The non-secret resume checkpoint crossed to the renderer. Never carries a job or step-up token. */
export interface DataPackageStateView {
  jobId: string;
  kind: 'export' | 'import';
  deviceLabel: string;
  snapshotAt: number;
  stage: 'rows' | 'media' | 'finish' | 'upload' | 'preview' | 'apply' | 'revert';
  tables: Record<string, { cursor: string | null; rows: number; bytes: number }>;
  counts: { rows: number; media: number };
  bytes: number;
  updatedAt: number;
}

/** Progress event pushed from the main-process export runner. No bytes, no secrets. */
export interface DataPackageProgressView {
  stage: 'rows' | 'media' | 'verifying' | 'finishing' | 'apply' | 'preview' | 'revert';
  table?: string;
  rows: number;
  media: number;
  bytes: number;
  totalTables: number;
  doneTables: number;
  /** Set on the first progress event: preview of total work from the snapshot metadata. */
  estimate?: { rows: number; bytes: number; days: number };
  /** True while the user has paused the run (no bytes are moving). */
  paused?: boolean;
}

/** A terminal export event: success with the attested result, or a closed error code. */
export type DataPackageExportEvent =
  | { kind: 'progress'; progress: DataPackageProgressView }
  | { kind: 'done'; result: DataPackageResultView }
  | { kind: 'error'; code: string };

/** The result of a completed export, crossed to the renderer (no secrets). */
export interface DataPackageResultView {
  jobId: string;
  packageId: string;
  outputDir: string;
  rows: number;
  media: number;
  bytes: number;
  manifestSha256: string;
  excluded: readonly { class: string; table: string; reason: string }[];
}

/** Renderer → main start request. Credentials are held only in main-process memory for this run. */
export interface StartDataPackageExportRequest {
  serverUrl: string;
  bearer: string;
  stepUpPassword: string;
  stepUpCode?: string;
  deviceLabel: string;
  clientKind: string;
}

/** Renderer → main import request. Only a local file PATH crosses IPC; bytes are read in main. */
export interface StartDataPackageImportRequest {
  serverUrl: string;
  bearer: string;
  stepUpPassword: string;
  stepUpCode?: string;
  deviceLabel: string;
  clientKind: string;
  /** Absolute path to the selected package file. No bytes cross IPC. */
  packagePath: string;
}

/** The result of a completed import, crossed to the renderer (no secrets, no row content). */
export interface DataPackageImportResultView {
  jobId: string;
  packageId: string;
  applied: Record<string, number>;
  skipped: Record<string, number>;
  rejected: { table: string; sourceId: string; code: string }[];
  mediaUploaded: number;
  archiveOk: boolean;
  counts: Record<string, number>;
  excluded: readonly { class: string; table: string; reason: string }[];
}

/** A terminal import or revert event. Progress events share DataPackageProgressView. */
export type DataPackageImportEvent =
  | { kind: 'progress'; progress: DataPackageProgressView }
  | { kind: 'done'; result: DataPackageImportResultView }
  | { kind: 'error'; code: string }
  | { kind: 'reverted'; done: boolean; processed: number };

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
  dialogs: {
    saveExport(fileUri: string, suggestedName: string): Promise<'saved' | 'cancelled'>;
    pickPackage(): Promise<string | null>;
  };
  /**
   * A COPY of a photo taken in the app, put into the InspectorHub folder of the system Pictures folder (the same on Windows and macOS). The renderer names the file by a fixed pattern
   * (`GALLERY_FILE_NAME`) and never a path; the main process decides the folder. It never deletes anything.
   */
  gallery: { save(name: string, data: Uint8Array): Promise<'saved'> };
  updater: {
    state(): Promise<UpdaterState>;
    onState(listener: (state: UpdaterState) => void): () => void;
    check(): Promise<void>;
    download(): Promise<void>;
    installAndRestart(): Promise<'restarting' | 'blocked-uploads' | 'blocked-transaction'>;
  };
  /** The one way the renderer reaches the system HEIC decoder. It cannot name an executable, a path or an argument. */
  media: { decodeHeic?: (request: DecodeHeicRequest) => Promise<DecodeHeicReply> };
  /** The A-1 job skeleton + A-2/A-3 export runner: non-secret resume state, free-space probe, power guard, start/cancel and progress events. */
  dataPackage: {
    resumeState(): Promise<DataPackageStateView | null>;
    clearState(): Promise<void>;
    diskSpace(): Promise<number | null>;
    setPowerSave(active: boolean): Promise<void>;
    startExport(request: StartDataPackageExportRequest): Promise<void>;
    cancelExport(): Promise<void>;
    pauseExport(): Promise<void>;
    resumeExport(): Promise<void>;
    startImport(request: StartDataPackageImportRequest): Promise<void>;
    /** Import a package AND then revert it — used only by the E2E harness to exercise revert. */
    revertImport(request: StartDataPackageImportRequest): Promise<void>;
    onEvent(listener: (event: DataPackageExportEvent) => void): () => void;
    onImportEvent(listener: (event: DataPackageImportEvent) => void): () => void;
  };
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
  dialogs: ['saveExport', 'pickPackage'],
  gallery: ['save'],
  updater: ['state', 'onState', 'check', 'download', 'installAndRestart'],
  media: ['decodeHeic'],
  dataPackage: ['resumeState', 'clearState', 'diskSpace', 'setPowerSave', 'startExport', 'cancelExport', 'pauseExport', 'resumeExport', 'startImport', 'revertImport', 'onEvent', 'onImportEvent'],
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
  dialogs: { saveExport: 'dialogs:save-export', pickPackage: 'dialogs:pick-package' },
  gallery: { save: 'gallery:save' },
  updater: {
    state: 'updater:state',
    check: 'updater:check',
    download: 'updater:download',
    installAndRestart: 'updater:install-and-restart',
  },
  media: { decodeHeic: 'media:decode-heic' },
  dataPackage: {
    resumeState: 'data-package:resume-state',
    clearState: 'data-package:clear-state',
    diskSpace: 'data-package:disk-space',
    setPowerSave: 'data-package:set-power-save',
    startExport: 'data-package:start-export',
    cancelExport: 'data-package:cancel-export',
    pauseExport: 'data-package:pause-export',
    resumeExport: 'data-package:resume-export',
    startImport: 'data-package:start-import',
    revertImport: 'data-package:revert-import',
  },
} as const;

type LeafValues<T> = T extends string ? T : { [K in keyof T]: LeafValues<T[K]> }[keyof T];
/** The name of any request channel, as a literal union. */
export type ChannelName = LeafValues<typeof CHANNELS>;

/**
 * The only file name the gallery channel accepts: "InspectorHub-", a date and time, a piece of the pending id (letters and digits) and an image
 * extension. No path separator, no dot but the last, no space: a name cannot climb out of the folder or name another file type.
 */
export const GALLERY_FILE_NAME = /^InspectorHub-[0-9]{8}-[0-9]{6}-[A-Za-z0-9]{1,16}\.(?:jpg|png|heic|heif|webp)$/;

/** Event channels (`webContents.send` to a preload listener). The listener receives the payload and nothing else. */
export const EVENT_CHANNELS = {
  uploaderEvent: 'uploader:event',
  authCallback: 'auth:callback',
  activeChange: 'app:active-change',
  updaterState: 'updater:state-changed',
  dataPackageEvent: 'data-package:event',
  dataPackageImportEvent: 'data-package:import-event',
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

const isUint8Array = (value: unknown): value is Uint8Array => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';

/** The renderer-side check of a decode reply: a closed shape, a closed code, a real buffer. */
export function isDecodeHeicReply(value: unknown): value is DecodeHeicReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply);
  if (reply.ok === true) return keys.length === 2 && isUint8Array(reply.jpeg);
  if (reply.ok === false) return keys.length === 2 && (HEIC_DECODE_CODES as readonly unknown[]).includes(reply.code);
  return false;
}
