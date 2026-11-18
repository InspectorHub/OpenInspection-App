import { describe, expect, it } from 'vitest';
import { readAllRows, readTable, type RowsDeps } from './rows';
import type { ExportFs, RunnerResponse, TableDescriptor } from './types';
import { parseDataFileName } from '@inspectorhub/data-package';

function memFs(): ExportFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async mkdir() {},
    async writeFile(path, data) { files.set(path, Uint8Array.from(data)); },
    async readFile(path) {
      const v = files.get(path);
      if (!v) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return v;
    },
    async rename(oldPath, newPath) {
      const v = files.get(oldPath);
      if (!v) throw new Error('missing');
      files.delete(oldPath);
      files.set(newPath, v);
    },
  };
}

const table: TableDescriptor = {
  table: 'inspections', columns: ['id'], keyset: ['id'], maxPageRows: 2, maxPageBytes: 4096,
};

function deps(http: RowsDeps['http']): RowsDeps {
  return {
    http,
    files: memFs(),
    credentials: { bearer: 'b', jobToken: 'j' },
    rowsUrl: (t, after, limit) => `https://x/api/rows/${t}?after=${after ?? ''}&limit=${limit}`,
    headers: () => ({ 'X-Data-Job': 'j', Authorization: 'Bearer b' }),
  };
}

const page = (rows: unknown[], next: string | null): RunnerResponse => ({
  status: 200, json: { success: true, data: { rows, next, bytes: 0, rowsScanned: rows.length } },
  text: '', budget: null,
});

describe('readTable', () => {
  it('pages until next is null, encoding each row into NDJSON shards', async () => {
    const d = deps(async (req) => {
      const after = new URL(req.url).searchParams.get('after');
      if (after === '') return page([{ id: 1 }, { id: 2 }], 'cur-2');
      if (after === 'cur-2') return page([{ id: 3 }], null);
      throw new Error('unexpected page: ' + req.url);
    });
    const result = await readTable(d, table, null);
    expect(result.rows).toBe(3);
    expect(result.cursor).toBeNull();
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    const text = result.files.map((f) => new TextDecoder().decode(f.bytes)).join('');
    expect(text.trim().split('\n').length).toBe(3);
  });

  it('resumes from the given cursor rather than page 1', async () => {
    const seen: string[] = [];
    const d = deps(async (req) => {
      seen.push(new URL(req.url).searchParams.get('after') ?? '');
      return page([{ id: 9 }], null);
    });
    const result = await readTable(d, table, 'resume-cursor');
    expect(result.rows).toBe(1);
    expect(seen[0]).toBe('resume-cursor');
    expect(result.cursor).toBeNull();
  });

  it('emits a zero-byte shard for a table with no rows', async () => {
    const d = deps(async () => page([], null));
    const result = await readTable(d, table, null);
    expect(result.rows).toBe(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.bytes.length).toBe(0);
    expect(result.files[0]!.rows).toBe(0);
  });

  it('rejects an oversized/unsafe cursor from the server', async () => {
    const d = deps(async () => page([{ id: 1 }], 'x'.repeat(3000)));
    await expect(readTable(d, table, null)).rejects.toThrow('rows-cursor');
  });

  it('rejects a non-object row and a non-200 status', async () => {
    const bad = deps(async () => ({ status: 200, json: { data: { rows: ['oops'], next: null } }, text: '', budget: null }));
    await expect(readTable(bad, table, null)).rejects.toThrow('rows-row');
    const err = deps(async () => ({ status: 500, json: {}, text: '', budget: null }));
    await expect(readTable(err, table, null)).rejects.toThrow('rows-status-500');
  });

  it('shard paths are parseable data-file names', async () => {
    const d = deps(async (req) => (new URL(req.url).searchParams.get('after') === ''
      ? page([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], 'c')
      : page([], null)));
    const result = await readTable(d, { ...table, maxPageRows: 1 }, null);
    for (const f of result.files) expect(parseDataFileName(f.path)).not.toBeNull();
  });
});

describe('readAllRows', () => {
  it('starts each table from its persisted cursor and aggregates totals', async () => {
    const d = deps(async (req) => {
      const t = new URL(req.url).pathname.split('/').pop();
      if (t === 'a') return page([{ id: 1 }], null);
      return page([{ id: 2 }, { id: 3 }], null);
    });
    const tables: TableDescriptor[] = [
      { ...table, table: 'a' }, { ...table, table: 'b' },
    ];
    const result = await readAllRows(d, tables, { a: null, b: 'b-cur' });
    expect(result.totalRows).toBe(3);
    expect(result.tables.find((t) => t.table === 'b')?.cursor).toBeNull();
  });
});
