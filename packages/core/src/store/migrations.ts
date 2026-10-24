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
    name: "assistant turns, subagent runs and token usage per session",
    sql: `
      ALTER TABLE sessions ADD COLUMN assistant_turn_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN subagent_run_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: "tasks and intents",
    sql: `
      ALTER TABLE sessions ADD COLUMN analyzed_fingerprint TEXT;

      CREATE TABLE tasks (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        title       TEXT NOT NULL,
        UNIQUE (session_id, position)
      );

      ALTER TABLE user_messages ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
      ALTER TABLE user_messages ADD COLUMN intent TEXT;
    `,
  },
  {
    version: 4,
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
        subagent     TEXT,
        timestamp    TEXT,
        UNIQUE (session_id, position)
      );
    `,
  },
  {
    version: 5,
    name: "task embeddings and clusters",
    sql: `
      CREATE TABLE clusters (
        id          INTEGER PRIMARY KEY,
        -- Null until the cheap model has named it.
        name        TEXT,
        created_at  TEXT NOT NULL
      );

      ALTER TABLE tasks ADD COLUMN embedding BLOB;
      ALTER TABLE tasks ADD COLUMN embedding_model TEXT;
      ALTER TABLE tasks ADD COLUMN cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL;
      CREATE INDEX tasks_cluster ON tasks (cluster_id);
    `,
  },
  {
    version: 6,
    name: "suggestions and their evidence",
    sql: `
      -- Suggestions in the format-neutral form (ADR 0005).
      CREATE TABLE suggestions (
        id             INTEGER PRIMARY KEY,
        kind           TEXT NOT NULL,
        state          TEXT NOT NULL,
        cluster_id     INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
        -- The Workflow's name when the Suggestion was written, shown if the Cluster is unnamed.
        workflow_name  TEXT,
        title          TEXT NOT NULL,
        trigger        TEXT NOT NULL,
        -- Kind-specific content as JSON, e.g. {"steps": [...]} for a Skill.
        body           TEXT NOT NULL,
        scope_kind     TEXT NOT NULL,
        scope_root     TEXT,
        scope_name     TEXT,
        created_at     TEXT NOT NULL,
        accepted_at    TEXT,
        rejected_at    TEXT,
        -- JSON array of the files written on accept.
        installed_files TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX suggestions_cluster ON suggestions (cluster_id);

      -- Evidence is a snapshot: Tasks are rebuilt when a Session is re-analyzed, so it names them instead of referencing rows.
      CREATE TABLE suggestion_evidence (
        suggestion_id  INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
        position       INTEGER NOT NULL,
        task_title     TEXT NOT NULL,
        task_at        TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        harness        TEXT NOT NULL,
        project_root   TEXT,
        project_name   TEXT,
        PRIMARY KEY (suggestion_id, position)
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
