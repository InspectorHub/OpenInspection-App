import type { Db } from '../../platform/db';

/**
 * Wraps a database so the nth statement matching `match` (counted over the wrapper's whole life, inside or outside a
 * transaction) throws. Everything else, transactions included, is delegated unchanged.
 */
export function failingDb(inner: Db, match: RegExp, nth: number): Db & { failures(): number } {
  let seen = 0;
  let failed = 0;
  const guard = (sql: string): void => {
    if (!match.test(sql)) return;
    seen += 1;
    if (seen === nth) {
      failed += 1;
      throw new Error('injected storage failure');
    }
  };
  const wrap = (db: Db): Db => ({
    execute: (sql) => {
      guard(sql);
      return db.execute(sql);
    },
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => {
      guard(sql);
      return db.run(sql, params);
    },
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
  });
  return { ...wrap(inner), failures: () => failed };
}
