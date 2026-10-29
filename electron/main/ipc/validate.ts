/**
 * Argument validators, one per request channel. Each takes the raw arguments exactly as they arrived and returns them
 * typed, or throws `InvalidArgumentError`. An argument that is missing, extra, of the wrong type or over its ceiling
 * is refused; an object with a key the contract does not name is refused too.
 */
import { MAX_DECODE_INPUT_BYTES, MAX_MEDIA_BYTES } from '../../../src/media/media-types.ts';
import type { DbParam, DecodeHeicRequest, UploaderStartOptions } from '../../shared/ipc-contract.ts';
import { DB_PARAM_STRING_MAX, DB_PARAMS_MAX, IPC_BYTES_MAX } from '../../shared/ipc-byte-limits.ts';

export class InvalidArgumentError extends Error {
  constructor() {
    super('invalid-argument');
    this.name = 'InvalidArgumentError';
  }
}

/** The ceiling of SQL text only; a bound value has its own ceilings below. */
const SQL_MAX = 100_000;
const SECRET_VALUE_MAX = 64 * 1024;
const KV_VALUE_MAX = 64 * 1024;
const PATH_MAX = 1024;
const URL_MAX = 2048;
const NAME_MAX = 255;
const HEADERS_MAX = 32;
/** The longest edge a photo may be scaled to; the engine's own ceiling is far below it. */
const MAX_LONG_EDGE = 16_384;
const HEADER_VALUE_MAX = 4096;

function fail(): never {
  throw new InvalidArgumentError();
}

const tag = (value: unknown): string => Object.prototype.toString.call(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && tag(value) === '[object Object]';

const text = (max: number) => (value: unknown): string => (typeof value === 'string' && value.length <= max ? value : fail());
const nonEmptyText = (max: number) => (value: unknown): string => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail());
const oneOf = <T extends string>(...allowed: readonly T[]) => (value: unknown): T => (allowed.includes(value as T) ? (value as T) : fail());
function uint8(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || tag(value) !== '[object Uint8Array]') return fail();
  if (value.byteLength > IPC_BYTES_MAX || value.buffer.byteLength > IPC_BYTES_MAX) return fail();
  return value as Uint8Array;
}

function dbParams(value: unknown): DbParam[] {
  if (!Array.isArray(value) || value.length > DB_PARAMS_MAX) return fail();
  let payloadBytes = 0;
  for (const item of value) {
    if (item === null || (typeof item === 'number' && Number.isFinite(item))) continue;
    if (typeof item === 'string' && item.length <= DB_PARAM_STRING_MAX) payloadBytes += item.length * 2;
    else payloadBytes += uint8(item).byteLength;
    if (payloadBytes > IPC_BYTES_MAX) return fail();
  }
  return value as DbParam[];
}

/** Exactly `parsers.length` arguments, or `required` to `parsers.length` when the trailing ones are optional. */
function args<P extends ((value: unknown) => unknown)[]>(raw: unknown[], parsers: P, required: number = parsers.length): unknown[] {
  if (raw.length < required || raw.length > parsers.length) return fail();
  return raw.map((value, index) => parsers[index]!(value));
}

const typed = <A extends unknown[]>(raw: unknown[], parsers: ((value: unknown) => unknown)[], required?: number): A => args(raw, parsers, required) as A;

const none = (raw: unknown[]): [] => typed<[]>(raw, []);
const one = (parse: (value: unknown) => unknown) => (raw: unknown[]): [string] => typed<[string]>(raw, [parse]);

function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail();
}

/** A header name is an RFC 9110 token; these two are set by the transport from the body it really sends. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = ['host', 'content-length', 'transfer-encoding', '__proto__'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function checkedHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > HEADERS_MAX) return fail();
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, header] of Object.entries(value)) {
    const ok = name.length <= NAME_MAX && HEADER_NAME.test(name) && !FORBIDDEN_HEADERS.includes(name.toLowerCase());
    if (!ok || typeof header !== 'string' || header.length > HEADER_VALUE_MAX || CONTROL_CHARACTERS.test(header)) return fail();
    out[name] = header;
  }
  return out;
}

function uploadOptions(value: unknown): UploaderStartOptions {
  if (!isRecord(value)) return fail();
  keysOnly(value, ['filePath', 'serverUrl', 'method', 'uploadType', 'fileField', 'mimeType', 'maxRetries', 'headers', 'notificationTitle']);
  const headers = checkedHeaders(value.headers);
  const retries = value.maxRetries;
  if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > 5) return fail();
  if (Object.keys(headers).some((name) => name !== 'x-client-version' && name !== 'x-client-platform')) return fail();
  if (Object.keys(headers).some((name) => name !== name.toLowerCase())) return fail();
  if (headers['x-client-platform'] !== 'windows' || (headers['x-client-version'] !== undefined && !/^[0-9A-Za-z.+-]{1,32}$/.test(headers['x-client-version']))) return fail();
  if (typeof value.fileField !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value.fileField)) return fail();
  if (typeof value.mimeType !== 'string' || !['image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'].includes(value.mimeType)) return fail();
  if (typeof value.notificationTitle !== 'string' || value.notificationTitle.length < 1 || value.notificationTitle.length > 80 || CONTROL_CHARACTERS.test(value.notificationTitle)) return fail();
  if (typeof value.serverUrl !== 'string' || CONTROL_CHARACTERS.test(value.serverUrl)) return fail();
  let serverUrl: URL;
  try { serverUrl = new URL(value.serverUrl); } catch { return fail(); }
  if ((serverUrl.protocol !== 'https:' && serverUrl.protocol !== 'http:') || serverUrl.username || serverUrl.password || serverUrl.hash) return fail();
  return {
    filePath: nonEmptyText(URL_MAX)(value.filePath),
    serverUrl: nonEmptyText(URL_MAX)(value.serverUrl),
    method: oneOf('POST')(value.method),
    uploadType: oneOf('multipart')(value.uploadType),
    fileField: nonEmptyText(NAME_MAX)(value.fileField),
    mimeType: nonEmptyText(NAME_MAX)(value.mimeType),
    maxRetries: retries,
    headers,
    notificationTitle: text(NAME_MAX)(value.notificationTitle),
  };
}

function decodeRequest(value: unknown): DecodeHeicRequest {
  if (!isRecord(value)) return fail();
  keysOnly(value, ['bytes', 'maxLongEdge', 'keepOriginal']);
  const { bytes, maxLongEdge, keepOriginal } = value;
  if (tag(bytes) !== '[object ArrayBuffer]') return fail();
  const length = (bytes as ArrayBuffer).byteLength;
  if (length === 0 || length > MAX_DECODE_INPUT_BYTES) return fail();
  if (typeof maxLongEdge !== 'number') return fail();
  const inRange = Number.isInteger(maxLongEdge) && maxLongEdge >= 1 && maxLongEdge <= MAX_LONG_EDGE;
  if (keepOriginal === undefined) {
    if (!inRange) return fail();
    return { bytes: bytes as ArrayBuffer, maxLongEdge };
  }
  if (!inRange && maxLongEdge !== Infinity) return fail();
  if (!isRecord(keepOriginal)) return fail();
  keysOnly(keepOriginal, ['maxBytes']);
  const { maxBytes } = keepOriginal;
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MEDIA_BYTES) return fail();
  return { bytes: bytes as ArrayBuffer, maxLongEdge, keepOriginal: { maxBytes } };
}

const path = nonEmptyText(PATH_MAX);
const KEY_PATTERN = /^(?!.*\.\.[\\/])[\x21-\x7e]{1,256}$/;
const key = (value: unknown): string => (typeof value === 'string' && KEY_PATTERN.test(value) ? value : fail());
const sql = nonEmptyText(SQL_MAX);
const utf8Text = (maxBytes: number) => (value: unknown): string => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) return fail();
  return value;
};

export const validators = {
  db: {
    open: none,
    execute: one(sql),
    query: (raw: unknown[]): [string, DbParam[] | undefined] => typed<[string, DbParam[] | undefined]>(raw, [sql, dbParams], 1),
    run: (raw: unknown[]): [string, DbParam[] | undefined] => typed<[string, DbParam[] | undefined]>(raw, [sql, dbParams], 1),
    begin: none,
    commit: none,
    rollback: none,
    inTransaction: none,
    close: none,
    setAsideUnreadable: none,
  },
  secrets: {
    get: one(key),
    set: (raw: unknown[]): [string, string] => typed<[string, string]>(raw, [key, utf8Text(SECRET_VALUE_MAX)]),
    remove: one(key),
  },
  kv: {
    get: one(key),
    set: (raw: unknown[]): [string, string] => typed<[string, string]>(raw, [key, utf8Text(KV_VALUE_MAX)]),
  },
  files: {
    write: (raw: unknown[]): [string, Uint8Array] => typed<[string, Uint8Array]>(raw, [path, uint8]),
    size: one(path),
    read: one(path),
    remove: one(path),
    displayUrl: one(path),
    fileUri: one(path),
    exists: one(path),
    list: one(path),
    removeCache: one(path),
    listCache: none,
    streamOpen: (raw: unknown[]): ['media' | 'cache', string] => typed<['media' | 'cache', string]>(raw, [oneOf('media', 'cache'), path]),
    streamAppend: (raw: unknown[]): [string, Uint8Array] => typed<[string, Uint8Array]>(raw, [key, uint8]),
    streamFinish: (raw: unknown[]): [string, 'commit' | 'abort'] => typed<[string, 'commit' | 'abort']>(raw, [key, oneOf('commit', 'abort')]),
  },
  uploader: {
    start: (raw: unknown[]): [UploaderStartOptions] => typed<[UploaderStartOptions]>(raw, [uploadOptions]),
    remove: one(key),
  },
  shell: {
    openExternal: one(nonEmptyText(URL_MAX)),
    openLogs: none,
    openDataFolder: none,
  },
  dialogs: {
    saveExport: (raw: unknown[]): [string, string] => typed<[string, string]>(raw, [nonEmptyText(URL_MAX), nonEmptyText(NAME_MAX)]),
  },
  updater: {
    state: none,
    check: none,
    download: none,
    installAndRestart: none,
  },
  media: {
    decodeHeic: (raw: unknown[]): [DecodeHeicRequest] => typed<[DecodeHeicRequest]>(raw, [decodeRequest]),
  },
};
