import type { Db } from '../platform/db';
import { stripBidi } from '../ui/worklist/format';

/**
 * The address of an inspection as the device has cached it, and the one cleaning every place that shows or carries it shares: the
 * work list titles, the label the exporter writes into a package's manifest, and the label the importer reads back. Keeping one
 * copy means an address looks the same everywhere and is cut at the same length.
 */

export const TITLE_MAX = 120;

export function truncate(text: string): string {
  const letters = Array.from(text);
  return letters.length > TITLE_MAX ? `${letters.slice(0, TITLE_MAX - 1).join('')}…` : text;
}

/** The address out of a cached `/api/inspections/{id}` body, or null for anything that is not the expected shape. */
export function addressOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) return null;
    const data = parsed.data;
    if (typeof data !== 'object' || data === null || !('inspection' in data)) return null;
    const inspection = data.inspection;
    if (typeof inspection !== 'object' || inspection === null || !('propertyAddress' in inspection)) return null;
    const address = inspection.propertyAddress;
    if (typeof address !== 'string') return null;
    const clean = stripBidi(address).trim();
    return clean.length === 0 ? null : truncate(clean);
  } catch {
    return null;
  }
}

/**
 * A label that came from outside (a package's manifest) made safe to show as plain text: anything that is not a string is no label;
 * direction controls and control characters go, runs of whitespace become one space, the ends are trimmed, and the length is the work
 * list's. Empty after that is no label.
 */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Only the start of a very long string is looked at: the rest would be cut anyway.
  const head = value.length > TITLE_MAX * 8 ? value.slice(0, TITLE_MAX * 8) : value;
  const clean = stripBidi(head)
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();
  return clean.length === 0 ? null : truncate(clean);
}

const CHUNK = 100;

/**
 * The cached address of each listed inspection of one account, in a few statements however many there are. An inspection with no
 * cached read, or one whose body has no address, is simply absent.
 */
export async function readCachedAddresses(db: Pick<Db, 'query'>, accountKeyValue: string, ids: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let at = 0; at < ids.length; at += CHUNK) {
    const slice = ids.slice(at, at + CHUNK);
    const marks = slice.map(() => '?').join(', ');
    const rows = await db.query<{ package_id: string; body: string }>(
      `SELECT package_id, body FROM resource_cache WHERE account_key = ? AND key = '/api/inspections/' || package_id AND package_id IN (${marks})`,
      [accountKeyValue, ...slice],
    );
    for (const row of rows) {
      const address = addressOf(row.body);
      if (address !== null) found.set(row.package_id, address);
    }
  }
  return found;
}
