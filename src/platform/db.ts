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

const UNUSABLE_MESSAGE =
  'Database connection is unusable: a transaction could not be rolled back and may still be open';

const DEFAULT_DEADLOCK_TIMEOUT_MS = 30_000;

/** Timer functions; injectable so tests can drive the deadlock timeout without real waiting. */
export interface DbTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DbOptions {
  /**
   * How long a queued call may wait behind one running transaction before it is
   * rejected (default 30_000). The bound restarts each time a different
   * transaction starts running, so time spent behind other queued work never
   * counts; a call is rejected only when a single transaction has been running
   * longer than this while the call waited.
   */
  deadlockTimeoutMs?: number;
  timers?: DbTimers;
}

interface Waiter {
  timer: unknown;
  abandoned: boolean;
  started: boolean;
  expire?: () => void;
}

const globalTimers: DbTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A `Db` over one connection: top-level calls run strictly in order, a
 * transaction holds the queue until it ends, and the failure modes that would
 * otherwise corrupt or hang the connection are surfaced as errors.
 *
 * Calls on the outer `Db` made while a transaction is open queue behind it and
 * run once it commits or rolls back. Unrelated tasks (persistence writes,
 * outbox replay) can therefore call `db` freely, but they stall for as long as
 * the transaction lasts, so keep transactions short and never await slow
 * non-database work (network, timers, user input) inside one.
 *
 * Re-entry: a call made on the outer `Db` from inside the transaction callback
 * queues behind the very transaction that is awaiting it. The webview has no
 * async context to tell that apart from an unrelated caller, so the wait is
 * bounded instead. The bound is per running transaction: each time a
 * transaction starts running, every call still waiting gets a fresh
 * `deadlockTimeoutMs`, and the clock stops when that transaction ends. A call
 * therefore rejects only if one single transaction runs longer than the limit
 * while it waits; any number of shorter transactions ahead of it never add up.
 * A rejected call is removed from the queue (it never runs) with an error
 * pointing at the `tx` handle. Neither the connection nor the transaction is
 * affected; the transaction proceeds as soon as its callback handles the
 * error. The bound covers only the wait; a call that has started is never cut
 * short.
 */
export function createDb(connection: TransactionalConnection, options: DbOptions = {}): Db {
  const queue = new SerialQueue();
  const topLevel = connection.statements(false);
  const inTransaction = connection.statements(true);
  const deadlockTimeoutMs = options.deadlockTimeoutMs ?? DEFAULT_DEADLOCK_TIMEOUT_MS;
  const timers = options.timers ?? globalTimers;
  let transactionRunning = false;
  let unusable: unknown = null;

  const unusableError = () => new Error(UNUSABLE_MESSAGE, { cause: unusable });

  /** Calls enqueued and not yet started; each one's timer measures one running transaction. */
  const waiting = new Set<Waiter>();

  const disarm = (waiter: Waiter) => {
    if (waiter.timer === undefined) return;
    timers.clearTimeout(waiter.timer);
    waiter.timer = undefined;
  };
  const arm = (waiter: Waiter) => {
    disarm(waiter);
    waiter.timer = timers.setTimeout(() => waiter.expire?.(), deadlockTimeoutMs);
  };
  /** A transaction became the running one: every waiting call starts a fresh bound. */
  const armAll = () => {
    for (const waiter of waiting) arm(waiter);
  };
  const disarmAll = () => {
    for (const waiter of waiting) disarm(waiter);
  };

  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    if (unusable !== null) return Promise.reject(unusableError());
    const guarded = () => (unusable !== null ? Promise.reject(unusableError()) : task());
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { timer: undefined, abandoned: false, started: false };
      waiter.expire = () => {
        if (waiter.started) return;
        waiter.abandoned = true;
        waiting.delete(waiter);
        reject(
          new Error(
            `Db call waited more than ${String(deadlockTimeoutMs)} ms behind an open transaction; ` +
              'it may have been issued from inside the transaction callback — use the tx handle',
          ),
        );
      };
      waiting.add(waiter);
      if (transactionRunning) arm(waiter);
      queue
        .run(() => {
          waiting.delete(waiter);
          disarm(waiter);
          if (waiter.abandoned) return Promise.resolve(undefined as T);
          waiter.started = true;
          return guarded();
        })
        .then(resolve, reject);
    });
  };

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
        armAll();
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
          disarmAll();
        }
      }),
  };
}
