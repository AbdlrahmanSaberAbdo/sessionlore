import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId, HarnessMessage, HarnessSession } from "../adapter.js";
import type { ResolvedProject } from "../project.js";
import { openDatabase, type Database } from "./database.js";
import { migrate } from "./migrations.js";

/** sessionlore's local data folder inside a home directory. */
export function dataDir(homeDir: string): string {
  return join(homeDir, ".sessionlore");
}

export function storePath(homeDir: string): string {
  return join(dataDir(homeDir), "sessionlore.db");
}

export interface StoredSession {
  id: string;
  harness: HarnessId;
  project: { name: string; path: string } | null;
  startedAt: string;
  endedAt: string;
  model: string | null;
  userMessageCount: number;
}

export type StoredMessage = (
  | { role: "user" | "assistant"; text: string }
  | { role: "tool"; name: string; status: string | null }
) & { timestamp: string | null; subagent?: string };

export interface StoredSessionDetail extends StoredSession {
  messages: StoredMessage[];
}

export interface SaveSessionInput {
  harness: HarnessId;
  session: HarnessSession;
  project: ResolvedProject | null;
  fingerprint: string;
  scanId: number;
}

/** The local store. All reads and writes of sessionlore's own data go through here. */
export class Store {
  private constructor(private readonly db: Database) {}

  /** Opens (creating if needed) the store at `path` and brings its schema up to date. */
  static open(path: string): Store {
    mkdirSync(dirname(path), { recursive: true });
    const db = openDatabase(path);
    migrate(db);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  startScan(at: Date): number {
    return this.db.run("INSERT INTO scans (started_at) VALUES (?)", at.toISOString()).lastInsertRowid;
  }

  finishScan(scanId: number, at: Date): void {
    this.db.run("UPDATE scans SET finished_at = ? WHERE id = ?", at.toISOString(), scanId);
  }

  /** Stores a Session read by a Scan. Returns whether it was new to the store. */
  saveSession(input: SaveSessionInput): { added: boolean } {
    const { harness, session, project, fingerprint, scanId } = input;
    return this.db.transaction(() => {
      const projectId = project ? this.projectId(project) : null;
      const existing = this.db.get<{ id: number }>(
        "SELECT id FROM sessions WHERE harness = ? AND external_id = ?",
        harness,
        session.externalId,
      );
      let sessionId: number;
      if (existing) {
        sessionId = existing.id;
        this.db.run(
          `UPDATE sessions SET project_id = ?, cwd = ?, started_at = ?, ended_at = ?, model = ?,
             scan_fingerprint = ?, last_scan_id = ? WHERE id = ?`,
          projectId,
          session.cwd,
          session.startedAt.toISOString(),
          session.endedAt.toISOString(),
          session.model ?? null,
          fingerprint,
          scanId,
          sessionId,
        );
        this.db.run("DELETE FROM user_messages WHERE session_id = ?", sessionId);
        this.db.run("DELETE FROM messages WHERE session_id = ?", sessionId);
      } else {
        sessionId = this.db.run(
          `INSERT INTO sessions (harness, external_id, project_id, cwd, started_at, ended_at, model, scan_fingerprint, last_scan_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          harness,
          session.externalId,
          projectId,
          session.cwd,
          session.startedAt.toISOString(),
          session.endedAt.toISOString(),
          session.model ?? null,
          fingerprint,
          scanId,
        ).lastInsertRowid;
      }
      session.userMessages.forEach((message, position) => {
        this.db.run(
          "INSERT INTO user_messages (session_id, position, text, timestamp) VALUES (?, ?, ?, ?)",
          sessionId,
          position,
          message.text,
          message.timestamp.toISOString(),
        );
      });
      (session.messages ?? []).forEach((message, position) => this.insertMessage(sessionId, position, message));
      return { added: !existing };
    });
  }

  /** One stored Session with its messages, or null if no Session has that id. */
  getSession(externalId: string): StoredSessionDetail | null {
    const session = this.querySessions("WHERE s.external_id = ?", externalId)[0];
    if (!session) return null;
    const rows = this.db.all<{
      role: string;
      text: string | null;
      tool_name: string | null;
      tool_status: string | null;
      subagent: string | null;
      timestamp: string | null;
    }>(
      `SELECT m.role, m.text, m.tool_name, m.tool_status, m.subagent, m.timestamp
         FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.external_id = ? AND s.harness = ?
        ORDER BY m.position`,
      externalId,
      session.harness,
    );
    const messages = rows.map((row): StoredMessage => {
      const extra = { timestamp: row.timestamp, ...(row.subagent ? { subagent: row.subagent } : {}) };
      return row.role === "tool"
        ? { role: "tool", name: row.tool_name ?? "", status: row.tool_status, ...extra }
        : { role: row.role as "user" | "assistant", text: row.text ?? "", ...extra };
    });
    return { ...session, messages };
  }

  /** All stored Sessions, latest first. */
  listSessions(): StoredSession[] {
    return this.querySessions("");
  }

  private querySessions(where: string, ...params: string[]): StoredSession[] {
    const rows = this.db.all<{
      external_id: string;
      harness: string;
      project_name: string | null;
      project_root: string | null;
      started_at: string;
      ended_at: string;
      model: string | null;
      user_message_count: number;
    }>(
      `SELECT s.external_id, s.harness, p.name AS project_name, p.root AS project_root,
              s.started_at, s.ended_at, s.model,
              (SELECT COUNT(*) FROM user_messages m WHERE m.session_id = s.id) AS user_message_count
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        ${where}
        ORDER BY s.started_at DESC, s.id DESC`,
      ...params,
    );
    return rows.map((row) => ({
      id: row.external_id,
      harness: row.harness as HarnessId,
      project: row.project_root && row.project_name ? { name: row.project_name, path: row.project_root } : null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      model: row.model,
      userMessageCount: Number(row.user_message_count),
    }));
  }

  private insertMessage(sessionId: number, position: number, message: HarnessMessage): void {
    this.db.run(
      `INSERT INTO messages (session_id, position, role, text, tool_name, tool_status, subagent, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      position,
      message.role,
      message.role === "tool" ? null : message.text,
      message.role === "tool" ? message.name : null,
      message.role === "tool" ? message.status : null,
      message.subagent ?? null,
      message.timestamp?.toISOString() ?? null,
    );
  }

  private projectId(project: ResolvedProject): number {
    this.db.run("INSERT INTO projects (root, name) VALUES (?, ?) ON CONFLICT (root) DO NOTHING", project.root, project.name);
    const row = this.db.get<{ id: number }>("SELECT id FROM projects WHERE root = ?", project.root);
    if (!row) throw new Error(`Project ${project.root} was not stored`);
    return row.id;
  }
}
