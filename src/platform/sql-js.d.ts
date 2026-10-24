declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;

  export interface Statement {
    bind(values?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }

  export interface Database {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string): unknown[];
    prepare(sql: string, params?: SqlValue[]): Statement;
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => Database;
  }

  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
