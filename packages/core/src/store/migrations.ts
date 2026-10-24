import type { Database } from "./database.js";

/**
 * Versioned schema migrations. Append new migrations to the end; never edit
 * one that has shipped. The applied version is kept in `PRAGMA user_version`.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "projects, scans, sessions and user messages",
    sql: `
      CREATE TABLE projects (
        id    INTEGER PRIMARY KEY,
        root  TEXT NOT NULL UNIQUE,
        name  TEXT NOT NULL
      );

      CREATE TABLE scans (
        id           INTEGER PRIMARY KEY,
        started_at   TEXT NOT NULL,
        finished_at  TEXT
      );

      CREATE TABLE sessions (
        id            INTEGER PRIMARY KEY,
        harness       TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        project_id    INTEGER REFERENCES projects(id),
        cwd           TEXT,
        started_at    TEXT NOT NULL,
        ended_at      TEXT NOT NULL,
        scan_fingerprint TEXT NOT NULL,
        last_scan_id  INTEGER NOT NULL REFERENCES scans(id),
        UNIQUE (harness, external_id)
      );

      CREATE TABLE user_messages (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        text        TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        UNIQUE (session_id, position)
      );
    `,
  },
  {
    version: 2,
    name: "session model and messages",
    sql: `
      ALTER TABLE sessions ADD COLUMN model TEXT;

      CREATE TABLE messages (
        id           INTEGER PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        role         TEXT NOT NULL,
        text         TEXT,
        tool_name    TEXT,
        tool_status  TEXT,
        timestamp    TEXT,
        UNIQUE (session_id, position)
      );
    `,
  },
];

export function migrate(db: Database, all: readonly Migration[] = migrations): void {
  const current = Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
  const latest = all.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `The sessionlore store is at schema version ${current}, newer than this version of sessionlore supports (${latest}). Upgrade sessionlore.`,
    );
  }
  for (const migration of all) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}
