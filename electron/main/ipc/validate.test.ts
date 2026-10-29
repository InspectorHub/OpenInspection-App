import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../../shared/ipc-contract.ts';
import { InvalidArgumentError, validators } from './validate.ts';

type Validator = (raw: unknown[]) => unknown[];

const bytes = (length: number): Uint8Array => new Uint8Array(length);
const uploadOptions = {
  filePath: 'file:///C:/media/a.jpg',
  serverUrl: 'https://engine.example/upload',
  method: 'POST',
  uploadType: 'multipart',
  fileField: 'file',
  mimeType: 'image/jpeg',
  maxRetries: 3,
  headers: { Authorization: 'Bearer x' },
  notificationTitle: 'Uploading',
};

/** The validator for each channel, the arguments it must accept, and arguments it must refuse. */
const TABLE: [channel: string, validate: Validator, valid: unknown[][], invalid: unknown[][]][] = [
  ['db:open', validators.db.open, [[]], [['x']]],
  ['db:execute', validators.db.execute, [['PRAGMA foreign_keys = ON']], [[], [1], ['a', 'b'], ['x'.repeat(200_000)]]],
  ['db:query', validators.db.query, [['SELECT 1'], ['SELECT ?', [1, 'a', null, bytes(2)]]], [[], ['SELECT ?', 'text'], ['SELECT ?', [{}]], ['SELECT ?', [true]], ['SELECT ?', [Number.NaN]], ['SELECT ?', ['a'], 'extra']]],
  ['db:run', validators.db.run, [['DELETE FROM t'], ['INSERT INTO t VALUES (?)', [bytes(4)]]], [[], ['SELECT ?', ['a'], 1], [['SELECT 1']]]],
  ['db:begin', validators.db.begin, [[]], [[1]]],
  ['db:commit', validators.db.commit, [[]], [[1]]],
  ['db:rollback', validators.db.rollback, [[]], [[1]]],
  ['db:in-transaction', validators.db.inTransaction, [[]], [[1]]],
  ['db:close', validators.db.close, [[]], [[1]]],
  ['db:set-aside-unreadable', validators.db.setAsideUnreadable, [[]], [[1]]],
  ['secrets:get', validators.secrets.get, [['refresh']], [[], [1], ['a', 'b'], ['k'.repeat(300)]]],
  ['secrets:set', validators.secrets.set, [['refresh', 'token']], [['refresh'], ['refresh', 1], ['refresh', 'v'.repeat(70_000)]]],
  ['secrets:remove', validators.secrets.remove, [['refresh']], [[], [null]]],
  ['kv:get', validators.kv.get, [['theme']], [[], [bytes(1)]]],
  ['kv:set', validators.kv.set, [['theme', 'dark']], [['theme'], [1, 'dark']]],
  ['files:write', validators.files.write, [['a/b.jpg', bytes(3)]], [['a/b.jpg'], ['a/b.jpg', 'text'], ['a/b.jpg', [1, 2]], [1, bytes(1)], ['a'.repeat(2000), bytes(1)]]],
  ['files:size', validators.files.size, [['a']], [[], [1]]],
  ['files:read', validators.files.read, [['a']], [[], [1]]],
  ['files:remove', validators.files.remove, [['a']], [[], [1]]],
  ['files:display-url', validators.files.displayUrl, [['a']], [[], [1]]],
  ['files:file-uri', validators.files.fileUri, [['a']], [[], [1]]],
  ['files:exists', validators.files.exists, [['a']], [[], [1]]],
  ['files:list', validators.files.list, [['a']], [[], [1]]],
  ['files:remove-cache', validators.files.removeCache, [['a']], [[], [1]]],
  ['files:list-cache', validators.files.listCache, [[]], [['a']]],
  ['files:stream-open', validators.files.streamOpen, [['media', 'a.jpg'], ['cache', 'b.zip']], [['media'], ['elsewhere', 'a.jpg'], [1, 'a.jpg']]],
  ['files:stream-append', validators.files.streamAppend, [['h1', bytes(3)]], [['h1'], ['h1', 'text'], [1, bytes(1)]]],
  ['files:stream-finish', validators.files.streamFinish, [['h1', 'commit'], ['h1', 'abort']], [['h1'], ['h1', 'keep'], [1, 'commit']]],
  ['uploader:start', validators.uploader.start, [[uploadOptions]], [[], ['text'], [{ ...uploadOptions, method: 'PUT' }], [{ ...uploadOptions, maxRetries: -1 }], [{ ...uploadOptions, headers: { a: 1 } }], [{ ...uploadOptions, extra: true }], [{ ...uploadOptions, fileField: undefined }]]],
  ['uploader:remove', validators.uploader.remove, [['id-1']], [[], [1]]],
  ['shell:open-external', validators.shell.openExternal, [['https://example.com/a']], [[], [1], ['u'.repeat(3000)]]],
  ['shell:open-logs', validators.shell.openLogs, [[]], [[1]]],
  ['shell:open-data-folder', validators.shell.openDataFolder, [[]], [[1]]],
  ['dialogs:save-export', validators.dialogs.saveExport, [['file:///C:/c/x.zip', 'export.zip']], [['file:///C:/c/x.zip'], [1, 'x'], ['file:///a', 'n'.repeat(400)]]],
  ['updater:state', validators.updater.state, [[]], [[1]]],
  ['updater:check', validators.updater.check, [[]], [[1]]],
  ['updater:download', validators.updater.download, [[]], [[1]]],
  ['updater:install-and-restart', validators.updater.installAndRestart, [[]], [[1]]],
  ['media:decode-heic', validators.media.decodeHeic, [[{ bytes: new ArrayBuffer(8), maxLongEdge: 2560 }]], [[], [{ bytes: new ArrayBuffer(8), maxLongEdge: 2560 }, 1]]],
];

const flatten = (tree: object): string[] => Object.values(tree).flatMap((value) => (typeof value === 'string' ? [value] : flatten(value as object)));

describe('channel validators', () => {
  it('has exactly one validator per request channel', () => {
    expect(TABLE.map(([channel]) => channel).sort()).toEqual(flatten(CHANNELS).sort());
  });

  it.each(TABLE)('%s accepts its arguments', (_channel, validate, valid) => {
    for (const raw of valid) expect(() => validate(raw)).not.toThrow();
  });

  it.each(TABLE)('%s refuses missing, extra and mistyped arguments', (_channel, validate, _valid, invalid) => {
    for (const raw of invalid) expect(() => validate(raw)).toThrow(InvalidArgumentError);
  });

  it('returns the arguments it accepted, with an omitted optional left out', () => {
    expect(validators.db.query(['SELECT 1'])).toEqual(['SELECT 1']);
    expect(validators.db.query(['SELECT ?', [1]])).toEqual(['SELECT ?', [1]]);
  });

  describe('byte transfer bounds', () => {
    const MIB = 1024 * 1024;

    it.each([
      ['files:write', (view: Uint8Array) => validators.files.write(['a', view])],
      ['files:stream-append', (view: Uint8Array) => validators.files.streamAppend(['h', view])],
      ['db:query', (view: Uint8Array) => validators.db.query(['SELECT ?', [view]])],
      ['db:run', (view: Uint8Array) => validators.db.run(['INSERT', [view]])],
    ] as const)('%s rejects oversized backing independently of visible length', (_channel, validate) => {
      expect(() => validate(new Uint8Array(new ArrayBuffer(64 * MIB), 103, 3))).toThrow(InvalidArgumentError);
      expect(() => validate(new Uint8Array(16 * MIB + 1))).toThrow(InvalidArgumentError);
      expect(() => validate(new Uint8Array(new ArrayBuffer(16 * MIB), 103, 3))).not.toThrow();
      expect(() => validate(new Uint8Array(16 * MIB))).not.toThrow();
    });

    it.each(['query', 'run'] as const)('db.%s enforces the aggregate 16 MiB params budget', (method) => {
      const strings = new Array<string>(7).fill('x'.repeat(MIB));
      expect(() => validators.db[method](['SELECT ?', [...strings, bytes(2 * MIB)]])).not.toThrow();
      expect(() => validators.db[method](['SELECT ?', [...strings, bytes(2 * MIB + 1)]])).toThrow(InvalidArgumentError);
      expect(() => validators.db[method](['SELECT ?', new Array<string>(8).fill('x'.repeat(MIB))])).not.toThrow();
      expect(() => validators.db[method](['SELECT ?', [...new Array<string>(8).fill('x'.repeat(MIB)), 'x']])).toThrow(InvalidArgumentError);
      expect(() => validators.db[method](['SELECT ?', [bytes(8 * MIB), bytes(8 * MIB + 1)]])).toThrow(InvalidArgumentError);
    });

    it('media.decodeHeic independently enforces its ArrayBuffer boundary', () => {
      for (const value of [new ArrayBuffer(0), new ArrayBuffer(50 * MIB + 1), new Uint8Array(8), null]) {
        expect(() => validators.media.decodeHeic([{ bytes: value, maxLongEdge: 2560 }])).toThrow(InvalidArgumentError);
      }
      expect(() => validators.media.decodeHeic([{ bytes: new ArrayBuffer(50 * MIB), maxLongEdge: 2560 }])).not.toThrow();
    });
  });
});
