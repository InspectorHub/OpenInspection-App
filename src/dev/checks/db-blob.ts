import { fail, fillerBytes, firstDifference, guarded, pass, type CheckDef } from './types';

const DOC = 'diag-blob';
const ONE_MIB = 1024 * 1024;

const def = { id: 'db-blob', title: '[diag] db-blob: binary values through the encrypted SQLite adapter' };

/** Every byte value once, in order. */
function allBytes(): Uint8Array {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) out[i] = i;
  return out;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) return Uint8Array.from(value as number[]);
  return null;
}

export const dbBlob: CheckDef = {
  ...def,
  hint: 'Writes three binary rows to a diag document, reads them back and compares every byte, then deletes them.',
  run: (ctx) =>
    guarded(def, async () => {
      const { db, platform } = ctx.services;
      const started = ctx.services.clock.now();
      const cases: [string, Uint8Array][] = [
        ['all256', allBytes()],
        ['mib1', fillerBytes(ONE_MIB, 0x9e3779b9)],
        ['empty', new Uint8Array(0)],
      ];
      try {
        await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [DOC]);
        for (const [, bytes] of cases) await db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [DOC, bytes]);
        const rows = await db.query<{ data: unknown }>('SELECT data FROM ydoc_updates WHERE doc_name = ? ORDER BY id', [DOC]);
        if (rows.length !== cases.length) return fail(def, `rows=${String(rows.length)} expected=${String(cases.length)} platform=${platform}`);
        let total = 0;
        for (const [index, [name, expected]] of cases.entries()) {
          const raw = rows[index]?.data;
          const got = asBytes(raw);
          if (got === null) return fail(def, `case=${name} readback=not_binary type=${typeof raw} platform=${platform}`);
          const at = firstDifference(expected, got);
          if (at !== -1) return fail(def, `case=${name} mismatch_at=${String(at)} expected_len=${String(expected.length)} got_len=${String(got.length)} platform=${platform}`);
          if (!(raw instanceof Uint8Array)) return fail(def, `case=${name} readback_type=not_uint8array platform=${platform}`);
          total += expected.length;
        }
        return pass(def, `blobs=${String(cases.length)} bytes=${String(total)} identical=yes platform=${platform} ms=${String(ctx.services.clock.now() - started)}`);
      } finally {
        await db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [DOC]).catch(() => undefined);
      }
    }),
};
