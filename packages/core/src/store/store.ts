import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId, HarnessMessage, HarnessSession, TokenUsage } from "../adapter.js";
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
  assistantTurnCount: number;
  subagentRunCount: number;
  tokens: TokenUsage;
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

  /** The change marker a stored Session was last read with, or null if it isn't stored. */
  sessionFingerprint(harness: HarnessId, externalId: string): string | null {
    const row = this.db.get<{ scan_fingerprint: string }>(
      "SELECT scan_fingerprint FROM sessions WHERE harness = ? AND external_id = ?",
      harness,
      externalId,
    );
    return row?.scan_fingerprint ?? null;
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
          `UPDATE sessions SET project_id = ?, cwd = ?, started_at = ?, ended_at = ?,
             scan_fingerprint = ?, last_scan_id = ?, assistant_turn_count = ?, subagent_run_count = ?,
             input_tokens = ?, output_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?, model = ?
           WHERE id = ?`,
          projectId,
          session.cwd,
          session.startedAt.toISOString(),
          session.endedAt.toISOString(),
          fingerprint,
          scanId,
          ...summaryValues(session),
          session.model ?? null,
          sessionId,
        );
        this.db.run("DELETE FROM user_messages WHERE session_id = ?", sessionId);
        this.db.run("DELETE FROM messages WHERE session_id = ?", sessionId);
      } else {
        sessionId = this.db.run(
          `INSERT INTO sessions (harness, external_id, project_id, cwd, started_at, ended_at, scan_fingerprint, last_scan_id,
             assistant_turn_count, subagent_run_count, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          harness,
          session.externalId,
          projectId,
          session.cwd,
          session.startedAt.toISOString(),
          session.endedAt.toISOString(),
          fingerprint,
          scanId,
          ...summaryValues(session),
          session.model ?? null,
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

  /**
   * Deletes every stored Session whose Project `keep` rejects (`null` for
   * Sessions without a Project), along with rejected Projects themselves.
   */
  removeSessionsUnless(keep: (project: ResolvedProject | null) => boolean): void {
    this.db.transaction(() => {
      for (const project of this.db.all<{ id: number; root: string; name: string }>("SELECT id, root, name FROM projects")) {
        if (keep({ root: project.root, name: project.name })) continue;
        this.db.run("DELETE FROM sessions WHERE project_id = ?", project.id);
        this.db.run("DELETE FROM projects WHERE id = ?", project.id);
      }
      if (!keep(null)) this.db.run("DELETE FROM sessions WHERE project_id IS NULL");
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
      assistant_turn_count: number;
      subagent_run_count: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
    }>(
      `SELECT s.external_id, s.harness, p.name AS project_name, p.root AS project_root,
              s.started_at, s.ended_at, s.model, s.assistant_turn_count, s.subagent_run_count,
              s.input_tokens, s.output_tokens, s.cache_creation_tokens, s.cache_read_tokens,
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
      assistantTurnCount: Number(row.assistant_turn_count),
      subagentRunCount: Number(row.subagent_run_count),
      tokens: {
        input: Number(row.input_tokens),
        output: Number(row.output_tokens),
        cacheCreation: Number(row.cache_creation_tokens),
        cacheRead: Number(row.cache_read_tokens),
      },
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

/** The per-Session summary columns, in the order the session queries list them. */
function summaryValues(session: HarnessSession): number[] {
  const { tokens } = session;
  return [session.assistantTurnCount, session.subagentRunCount, tokens.input, tokens.output, tokens.cacheCreation, tokens.cacheRead];
}
