export interface Db {
  execute(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/**
 * Runs tasks one at a time, in call order. A single SQLite connection has one
 * transaction state, so top-level operations must not interleave with an open
 * transaction.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Builds the handle passed to `transaction()` callbacks. Statements go straight
 * to the connection (the queue is held by the outer transaction), and a nested
 * `transaction()` joins the outer one: a failure anywhere rolls back the whole.
 */
export function joinedTransactionHandle(ops: Pick<Db, 'execute' | 'query' | 'run'>): Db {
  const handle: Db = {
    execute: (sql) => ops.execute(sql),
    query: (sql, params) => ops.query(sql, params),
    run: (sql, params) => ops.run(sql, params),
    transaction: (fn) => fn(handle),
  };
  return handle;
}
