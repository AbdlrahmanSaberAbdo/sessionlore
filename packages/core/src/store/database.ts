import { existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * The only module that touches the SQLite driver (ADR 0006). Everything else
 * goes through `Database`, so the driver can be swapped if `node:sqlite` falls short.
 */

export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

export interface Database {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
    transaction: (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}

/** Read access to a database habitlore does not own, such as Harness storage. */
export interface ReadOnlyDatabase {
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  close(): void;
}

/**
 * Opens a database strictly read-only, never creating or changing any file.
 * While another process (e.g. a running Harness) has the database open, its
 * `-wal` file exists and must be read, so the database is opened plainly
 * read-only. Without a `-wal` file nobody is writing to it; then it is opened
 * `immutable`, because a plain read-only open of a WAL database would leave
 * new `-wal` and `-shm` files behind.
 */
export function openReadOnlyDatabase(path: string): ReadOnlyDatabase {
  const inUse = existsSync(`${path}-wal`);
  const db = inUse
    ? new DatabaseSync(path, { readOnly: true })
    : new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return {
    get: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}
