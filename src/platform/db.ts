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

type Statements = Pick<Db, 'execute' | 'query' | 'run'>;

/** What an adapter supplies so `createDb` can add queueing and transaction safety. */
export interface TransactionalConnection {
  /** Statement runners; `inTransaction` is true for those used inside a manual transaction. */
  statements(inTransaction: boolean): Statements;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Called after a failed rollback: does the connection still hold a transaction?
   * When absent, a failed rollback is always treated as leaving one open.
   */
  hasOpenTransaction?(): Promise<boolean>;
}

/** Shared by a transaction and every nested `transaction()` call made through its handle. */
interface TransactionState {
  nestedFailed: boolean;
  nestedCause: unknown;
}

/**
 * Builds the handle passed to `transaction()` callbacks. Statements go straight
 * to the connection (the queue is held by the outer transaction). A nested
 * `transaction()` joins the outer one without a savepoint, so it cannot undo
 * its own writes alone; instead a failing nested transaction marks the whole
 * outer transaction rollback-only, and the outer transaction rejects and rolls
 * back even if its callback caught the nested error.
 */
function transactionHandle(ops: Statements, state: TransactionState): Db {
  const handle: Db = {
    execute: (sql) => ops.execute(sql),
    query: (sql, params) => ops.query(sql, params),
    run: (sql, params) => ops.run(sql, params),
    transaction: async (fn) => {
      try {
        return await fn(handle);
      } catch (err) {
        if (!state.nestedFailed) {
          state.nestedFailed = true;
          state.nestedCause = err;
        }
        throw err;
      }
    },
  };
  return handle;
}

const IN_TRANSACTION_MESSAGE =
  'Db was used from inside its own transaction callback; use the tx handle passed to the callback instead';
const UNUSABLE_MESSAGE =
  'Database connection is unusable: a transaction could not be rolled back and may still be open';

/**
 * A `Db` over one connection: top-level calls run strictly in order, a
 * transaction holds the queue until it ends, and the three failure modes that
 * would otherwise corrupt or hang the connection are surfaced as errors.
 *
 * Re-entry: awaiting the outer `Db` inside a transaction callback would queue
 * behind the very transaction waiting on it, so any outer-`Db` call made while
 * a transaction callback is running rejects. That also rejects an unrelated
 * caller that happens to call during that window, because there is no async
 * context to tell the two apart; callers needing concurrent access must wait
 * for the transaction to settle.
 */
export function createDb(connection: TransactionalConnection): Db {
  const queue = new SerialQueue();
  const topLevel = connection.statements(false);
  const inTransaction = connection.statements(true);
  let transactionRunning = false;
  let unusable: unknown = null;

  const failFast = (): Promise<never> | null => {
    if (unusable !== null) return Promise.reject(new Error(UNUSABLE_MESSAGE, { cause: unusable }));
    if (transactionRunning) return Promise.reject(new Error(IN_TRANSACTION_MESSAGE));
    return null;
  };

  const queued = <T>(task: () => Promise<T>): Promise<T> =>
    failFast() ??
    queue.run(() => {
      if (unusable !== null) return Promise.reject(new Error(UNUSABLE_MESSAGE, { cause: unusable }));
      return task();
    });

  async function rollbackOrMarkUnusable(): Promise<void> {
    try {
      await connection.rollback();
      return;
    } catch (rollbackError) {
      let stillOpen = true;
      if (connection.hasOpenTransaction) {
        try {
          stillOpen = await connection.hasOpenTransaction();
        } catch {
          stillOpen = true;
        }
      }
      if (stillOpen) unusable = rollbackError;
    }
  }

  return {
    execute: (sql) => queued(() => topLevel.execute(sql)),
    query: <T>(sql: string, params?: unknown[]) => queued(() => topLevel.query<T>(sql, params)),
    run: (sql, params) => queued(() => topLevel.run(sql, params)),
    transaction: <T>(fn: (tx: Db) => Promise<T>) =>
      queued(async () => {
        const state: TransactionState = { nestedFailed: false, nestedCause: undefined };
        transactionRunning = true;
        try {
          await connection.begin();
          try {
            const out = await fn(transactionHandle(inTransaction, state));
            if (state.nestedFailed) {
              throw new Error('Transaction rolled back because a nested transaction failed', {
                cause: state.nestedCause,
              });
            }
            await connection.commit();
            return out;
          } catch (err) {
            await rollbackOrMarkUnusable();
            throw err;
          }
        } finally {
          transactionRunning = false;
        }
      }),
  };
}
