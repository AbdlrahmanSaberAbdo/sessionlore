import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessId, HarnessMessage, HarnessSession, TokenUsage } from "../adapter.js";
import type { Intent, SplitTask } from "@sessionlore/analysis";
import type { ResolvedProject } from "../project.js";
import type { Evidence, Scope, Suggestion, SuggestionKind, SuggestionState } from "../suggestion.js";
import { openDatabase, type Database, type SqlValue } from "./database.js";
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

/** A Session whose current content has not been analyzed yet. */
export interface SessionToAnalyze {
  /** Store id, for `saveAnalysis`. */
  key: number;
  id: string;
  fingerprint: string;
  project: ResolvedProject | null;
  /** User Message texts in order. */
  userMessages: string[];
}

export interface StoredTask {
  title: string;
  userMessages: { text: string; intent: Intent }[];
}

export interface SessionTasks {
  id: string;
  harness: HarnessId;
  project: { name: string; path: string } | null;
  tasks: StoredTask[];
}

export interface TaskToEmbed {
  key: number;
  title: string;
  /** The text of the Task's first User Message. */
  firstMessage: string | undefined;
}

export interface ClusterTask {
  title: string;
  /** Id of the Session the Task belongs to. */
  session: string;
  /** The Task's place among its Session's Tasks, from 0. */
  position: number;
  harness: HarnessId;
  project: { name: string; path: string } | null;
  /** When the Task started: its first User Message's timestamp. */
  at: string;
}

/** Workflows' Clusters of Tasks, or Correction Clusters of Corrections. */
export type ClusterKind = "tasks" | "corrections";

const clusterTables = {
  tasks: { clusters: "clusters", members: "tasks", column: "cluster_id", redirects: "cluster_redirects" },
  corrections: {
    clusters: "correction_clusters",
    members: "user_messages",
    column: "correction_cluster_id",
    redirects: "correction_cluster_redirects",
  },
} as const;

export interface AnalyzedUserMessage {
  /** When the person sent it. */
  at: string;
  intent: Intent;
  project: { name: string; path: string } | null;
}

export interface StoredCluster {
  id: number;
  /** Null until the cheap model has named it. */
  name: string | null;
  tasks: ClusterTask[];
}

/** A Suggestion as written, before it has an id or a state. */
export type NewSuggestion = {
  title: string;
  scope: Scope;
  evidence: readonly Evidence[];
  createdAt: Date;
} & (
  | { kind: "skill"; workflow: { id: number; name: string }; trigger: string; steps: readonly string[] }
  | { kind: "rule"; correctionCluster: { id: number; name: string }; rule: string }
);

export interface ClusterCorrection {
  text: string;
  /** Title of the Task the Correction belongs to. */
  task: string;
  /** When that Task started. */
  taskAt: string;
  /** Id of the Session the Correction belongs to. */
  session: string;
  harness: HarnessId;
  project: { name: string; path: string } | null;
  /** The Correction's timestamp. */
  at: string;
}

export interface StoredCorrectionCluster {
  id: number;
  /** Null until the cheap model has named it. */
  name: string | null;
  corrections: ClusterCorrection[];
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
        this.db.run("DELETE FROM tasks WHERE session_id = ?", sessionId);
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

  /** Sessions never analyzed, or changed since their last Analysis. */
  sessionsToAnalyze(): SessionToAnalyze[] {
    return this.sessionsWithMessages(
      "WHERE s.analyzed_fingerprint IS NULL OR s.analyzed_fingerprint <> s.scan_fingerprint",
    );
  }

  /** A stored Session with its User Messages, or null if no Session has that id. */
  sessionWithMessages(id: string): SessionToAnalyze | null {
    return this.sessionsWithMessages("WHERE s.external_id = ?", id)[0] ?? null;
  }

  private sessionsWithMessages(where: string, ...params: SqlValue[]): SessionToAnalyze[] {
    const sessions = this.db.all<{
      id: number;
      external_id: string;
      scan_fingerprint: string;
      project_name: string | null;
      project_root: string | null;
    }>(
      `SELECT s.id, s.external_id, s.scan_fingerprint, p.name AS project_name, p.root AS project_root
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        ${where}
        ORDER BY s.started_at, s.id`,
      ...params,
    );
    return sessions.map((s) => ({
      key: s.id,
      id: s.external_id,
      fingerprint: s.scan_fingerprint,
      project: s.project_root && s.project_name ? { root: s.project_root, name: s.project_name } : null,
      userMessages: this.userMessageTexts(s.id),
    }));
  }

  /** Replaces a Session's Tasks with the result of analyzing the content identified by `fingerprint`. */
  saveAnalysis(sessionKey: number, fingerprint: string, tasks: readonly SplitTask[]): void {
    this.db.transaction(() => {
      this.db.run(
        "UPDATE user_messages SET task_id = NULL, intent = NULL, correction_cluster_id = NULL WHERE session_id = ?",
        sessionKey,
      );
      this.db.run("DELETE FROM tasks WHERE session_id = ?", sessionKey);
      tasks.forEach((task, position) => {
        const taskId = this.db.run(
          "INSERT INTO tasks (session_id, position, title) VALUES (?, ?, ?)",
          sessionKey,
          position,
          task.title,
        ).lastInsertRowid;
        for (const message of task.messages) {
          this.db.run(
            "UPDATE user_messages SET task_id = ?, intent = ? WHERE session_id = ? AND position = ?",
            taskId,
            message.intent,
            sessionKey,
            message.index,
          );
        }
      });
      this.db.run("UPDATE sessions SET analyzed_fingerprint = ? WHERE id = ?", fingerprint, sessionKey);
    });
  }

  /** Analyzed Sessions with their Tasks, latest Session first. */
  listTasks(): SessionTasks[] {
    const sessions = this.db.all<{
      id: number;
      external_id: string;
      harness: string;
      project_name: string | null;
      project_root: string | null;
    }>(
      `SELECT s.id, s.external_id, s.harness, p.name AS project_name, p.root AS project_root
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.analyzed_fingerprint IS NOT NULL
        ORDER BY s.started_at DESC, s.id DESC`,
    );
    return sessions.map((s) => {
      const tasks = this.db.all<{ id: number; title: string }>(
        "SELECT id, title FROM tasks WHERE session_id = ? ORDER BY position",
        s.id,
      );
      return {
        id: s.external_id,
        harness: s.harness as HarnessId,
        project: s.project_root && s.project_name ? { name: s.project_name, path: s.project_root } : null,
        tasks: tasks.map((t) => ({
          title: t.title,
          userMessages: this.db
            .all<{ text: string; intent: string }>(
              "SELECT text, intent FROM user_messages WHERE task_id = ? ORDER BY position",
              t.id,
            )
            .map((m) => ({ text: m.text, intent: m.intent as Intent })),
        })),
      };
    });
  }

  /** Tasks with no embedding from `modelId` yet, with the text to embed them as. */
  tasksToEmbed(modelId: string): TaskToEmbed[] {
    return this.db
      .all<{ id: number; title: string; first_message: string | null }>(
        `SELECT t.id, t.title,
                (SELECT m.text FROM user_messages m WHERE m.task_id = t.id ORDER BY m.position LIMIT 1) AS first_message
           FROM tasks t JOIN sessions s ON s.id = t.session_id
          WHERE t.embedding IS NULL OR t.embedding_model IS NOT ?
          ORDER BY s.started_at, s.id, t.position`,
        modelId,
      )
      .map((t) => ({ key: t.id, title: t.title, firstMessage: t.first_message ?? undefined }));
  }

  saveEmbeddings(modelId: string, embeddings: readonly { key: number; vector: readonly number[] }[]): void {
    this.db.transaction(() => {
      for (const { key, vector } of embeddings) {
        this.db.run(
          "UPDATE tasks SET embedding = ?, embedding_model = ? WHERE id = ?",
          new Uint8Array(Float32Array.from(vector).buffer),
          modelId,
          key,
        );
      }
    });
  }

  /** Every Cluster with the `modelId` embeddings of its Tasks. */
  clusterVectors(modelId: string): { id: number; vectors: number[][] }[] {
    const byCluster = new Map<number, number[][]>();
    for (const row of this.db.all<{ cluster_id: number; embedding: Uint8Array | null; embedding_model: string | null }>(
      "SELECT c.id AS cluster_id, t.embedding, t.embedding_model FROM clusters c LEFT JOIN tasks t ON t.cluster_id = c.id ORDER BY c.id, t.id",
    )) {
      const vectors = byCluster.get(row.cluster_id) ?? [];
      byCluster.set(row.cluster_id, vectors);
      if (row.embedding && row.embedding_model === modelId) vectors.push(decodeVector(row.embedding));
    }
    return [...byCluster].map(([id, vectors]) => ({ id, vectors }));
  }

  /** Embedded Tasks that belong to no Cluster yet, oldest Session first. */
  unclusteredTasks(modelId: string): { key: number; vector: number[] }[] {
    return this.db
      .all<{ id: number; embedding: Uint8Array }>(
        `SELECT t.id, t.embedding FROM tasks t JOIN sessions s ON s.id = t.session_id
          WHERE t.cluster_id IS NULL AND t.embedding IS NOT NULL AND t.embedding_model = ?
          ORDER BY s.started_at, s.id, t.position`,
        modelId,
      )
      .map((t) => ({ key: t.id, vector: decodeVector(t.embedding) }));
  }

  /** Puts Tasks into existing Clusters or into new ones, then drops Clusters left without Tasks. */
  placeTasks(placements: readonly ({ task: number } & ({ cluster: number } | { newCluster: number }))[], at: Date): void {
    this.db.transaction(() => {
      const created = new Map<number, number>();
      for (const placement of placements) {
        let cluster: number;
        if ("cluster" in placement) cluster = placement.cluster;
        else {
          cluster = created.get(placement.newCluster) ?? this.newCluster("tasks", at);
          created.set(placement.newCluster, cluster);
        }
        this.db.run("UPDATE tasks SET cluster_id = ? WHERE id = ?", cluster, placement.task);
      }
      this.db.run("DELETE FROM clusters WHERE id NOT IN (SELECT cluster_id FROM tasks WHERE cluster_id IS NOT NULL)");
    });
  }

  /** Every Task with a `modelId` embedding and the Cluster it is in now, oldest Session first. */
  embeddedTasks(modelId: string): { key: number; vector: number[]; cluster: number | null }[] {
    return this.db
      .all<{ id: number; embedding: Uint8Array; cluster_id: number | null }>(
        `SELECT t.id, t.embedding, t.cluster_id FROM tasks t JOIN sessions s ON s.id = t.session_id
          WHERE t.embedding IS NOT NULL AND t.embedding_model = ?
          ORDER BY s.started_at, s.id, t.position`,
        modelId,
      )
      .map((t) => ({ key: t.id, vector: decodeVector(t.embedding), cluster: t.cluster_id }));
  }

  /** Every Correction with a `modelId` embedding and the Correction Cluster it is in now, oldest Session first. */
  embeddedCorrections(modelId: string): { key: number; vector: number[]; cluster: number | null }[] {
    return this.db
      .all<{ id: number; embedding: Uint8Array; correction_cluster_id: number | null }>(
        `SELECT m.id, m.embedding, m.correction_cluster_id FROM user_messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.intent = 'Correction' AND m.embedding IS NOT NULL AND m.embedding_model = ?
          ORDER BY s.started_at, s.id, m.position`,
        modelId,
      )
      .map((m) => ({ key: m.id, vector: decodeVector(m.embedding), cluster: m.correction_cluster_id }));
  }

  /**
   * Replaces every Cluster (or Correction Cluster) with `groups` (ADR 0008).
   * A group with an `heir` keeps that Cluster's id and name; the others become
   * new Clusters. Each old Cluster that is no group's heir is folded into the
   * group it maps to (`targets`): rows in other tables that point at it are
   * re-pointed and its id redirects there. Members in no group are left
   * unclustered. Returns each group's id.
   */
  recluster(
    kind: ClusterKind,
    groups: readonly { heir: number | undefined; members: readonly number[] }[],
    targets: ReadonlyMap<number, number>,
    at: Date,
  ): number[] {
    const { clusters, members, column, redirects } = clusterTables[kind];
    return this.db.transaction(() => {
      const ids = groups.map((g) => g.heir ?? this.newCluster(kind, at));
      this.db.run(`UPDATE ${members} SET ${column} = NULL WHERE ${column} IS NOT NULL`);
      groups.forEach((g, i) => {
        for (const member of g.members) this.db.run(`UPDATE ${members} SET ${column} = ? WHERE id = ?`, ids[i]!, member);
      });
      const heirs = new Set(groups.map((g) => g.heir));
      const references = this.db.all<{ tbl: string; col: string }>(
        `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m, pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND f."table" = ? AND m.name NOT IN (?, ?)`,
        clusters,
        members,
        redirects,
      );
      for (const [old, group] of targets) {
        if (heirs.has(old)) continue;
        const to = ids[group]!;
        for (const { tbl, col } of references) this.db.run(`UPDATE "${tbl}" SET "${col}" = ? WHERE "${col}" = ?`, to, old);
        this.db.run(`UPDATE ${redirects} SET new_id = ? WHERE new_id = ?`, to, old);
        this.db.run(`INSERT OR REPLACE INTO ${redirects} (old_id, new_id) VALUES (?, ?)`, old, to);
      }
      this.db.run(`DELETE FROM ${clusters} WHERE id NOT IN (SELECT ${column} FROM ${members} WHERE ${column} IS NOT NULL)`);
      return ids;
    });
  }

  /** Adds an empty Cluster, with an id no redirect uses, so a retired id never names a different Cluster. */
  private newCluster(kind: ClusterKind, at: Date): number {
    const { clusters, redirects } = clusterTables[kind];
    return this.db.run(
      `INSERT INTO ${clusters} (id, created_at) VALUES (
         (SELECT MAX(id) FROM (SELECT MAX(id) AS id FROM ${clusters} UNION ALL SELECT MAX(old_id) FROM ${redirects})) + 1, ?)`,
      at.toISOString(),
    ).lastInsertRowid;
  }

  /** The id a Cluster has now: itself, or the Cluster a re-cluster folded it into. Null if neither exists. */
  resolveCluster(kind: ClusterKind, id: number): number | null {
    const { clusters, redirects } = clusterTables[kind];
    const row = this.db.get<{ id: number }>(
      `SELECT id FROM ${clusters} WHERE id = ? UNION ALL SELECT new_id AS id FROM ${redirects} WHERE old_id = ? LIMIT 1`,
      id,
      id,
    );
    return row?.id ?? null;
  }

  /** Clusters the cheap model has not named yet that have at least `minTasks` Tasks, with their Task titles. */
  unnamedClusters(minTasks: number): { id: number; taskTitles: string[] }[] {
    return this.db
      .all<{ id: number }>(
        `SELECT c.id FROM clusters c
          WHERE c.name IS NULL AND (SELECT COUNT(*) FROM tasks t WHERE t.cluster_id = c.id) >= ?
          ORDER BY c.id`,
        minTasks,
      )
      .map((c) => ({
        id: c.id,
        taskTitles: this.db
          .all<{ title: string }>("SELECT title FROM tasks WHERE cluster_id = ? ORDER BY id", c.id)
          .map((t) => t.title),
      }));
  }

  nameCluster(id: number, name: string): void {
    this.db.run("UPDATE clusters SET name = ? WHERE id = ?", name, id);
  }

  /** Every Cluster with its Tasks, oldest Task first. */
  listClusters(): StoredCluster[] {
    const clusters = new Map<number, StoredCluster>();
    for (const row of this.db.all<{
      cluster_id: number;
      name: string | null;
      title: string;
      position: number;
      session_id: string;
      harness: string;
      project_name: string | null;
      project_root: string | null;
      at: string;
    }>(
      `SELECT c.id AS cluster_id, c.name, t.title, t.position, s.external_id AS session_id, s.harness,
              p.name AS project_name, p.root AS project_root,
              COALESCE((SELECT MIN(m.timestamp) FROM user_messages m WHERE m.task_id = t.id), s.started_at) AS at
         FROM clusters c
         JOIN tasks t ON t.cluster_id = c.id
         JOIN sessions s ON s.id = t.session_id
         LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY c.id, at, s.id, t.position`,
    )) {
      const cluster = clusters.get(row.cluster_id) ?? { id: row.cluster_id, name: row.name, tasks: [] };
      clusters.set(row.cluster_id, cluster);
      cluster.tasks.push({
        title: row.title,
        session: row.session_id,
        position: row.position,
        harness: row.harness as HarnessId,
        project: row.project_root && row.project_name ? { name: row.project_name, path: row.project_root } : null,
        at: row.at,
      });
    }
    return [...clusters.values()];
  }

  /** The User Messages of one Task, identified by its Session and position. */
  taskMessages(harness: HarnessId, sessionId: string, position: number): { text: string; intent: Intent }[] {
    return this.db
      .all<{ text: string; intent: string }>(
        `SELECT m.text, m.intent FROM user_messages m
           JOIN tasks t ON t.id = m.task_id
           JOIN sessions s ON s.id = t.session_id
          WHERE s.harness = ? AND s.external_id = ? AND t.position = ?
          ORDER BY m.position`,
        harness,
        sessionId,
        position,
      )
      .map((m) => ({ text: m.text, intent: m.intent as Intent }));
  }

  /** Stores a new Pending Suggestion and returns its id. */
  createSuggestion(input: NewSuggestion): number {
    return this.db.transaction(() => {
      const { scope } = input;
      const id = this.db.run(
        `INSERT INTO suggestions (kind, state, cluster_id, correction_cluster_id, workflow_name, title, trigger, body, scope_kind, scope_root, scope_name, created_at)
         VALUES (?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.kind,
        input.kind === "skill" ? input.workflow.id : null,
        input.kind === "rule" ? input.correctionCluster.id : null,
        // The source's name when written (Workflow or Correction Cluster), shown if it is unnamed later.
        input.kind === "skill" ? input.workflow.name : input.correctionCluster.name,
        input.title,
        input.kind === "skill" ? input.trigger : "",
        // Kind-specific content.
        JSON.stringify(input.kind === "skill" ? { steps: input.steps } : { rule: input.rule }),
        scope.kind,
        scope.kind === "project" ? scope.project.path : null,
        scope.kind === "project" ? scope.project.name : null,
        input.createdAt.toISOString(),
      ).lastInsertRowid;
      input.evidence.forEach((e, position) => {
        this.db.run(
          `INSERT INTO suggestion_evidence (suggestion_id, position, task_title, task_at, session_id, harness, project_root, project_name, correction_text, correction_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          position,
          e.task.title,
          e.task.at,
          e.session.id,
          e.session.harness,
          e.project?.path ?? null,
          e.project?.name ?? null,
          e.correction?.text ?? null,
          e.correction?.at ?? null,
        );
      });
      return id;
    });
  }

  /** Ids of the Correction Clusters that already have a Rule Suggestion, in any state. */
  correctionClustersWithRules(): Set<number> {
    return new Set(
      this.db
        .all<{ correction_cluster_id: number }>(
          "SELECT DISTINCT correction_cluster_id FROM suggestions WHERE kind = 'rule' AND correction_cluster_id IS NOT NULL",
        )
        .map((r) => r.correction_cluster_id),
    );
  }

  /** Ids of the Workflows that already have a Suggestion of `kind`, in any state. */
  workflowsWithSuggestions(kind: SuggestionKind): Set<number> {
    return new Set(
      this.db
        .all<{ cluster_id: number }>(
          "SELECT DISTINCT cluster_id FROM suggestions WHERE kind = ? AND cluster_id IS NOT NULL",
          kind,
        )
        .map((r) => r.cluster_id),
    );
  }

  /** Suggestions, oldest first, optionally only those in `state`. */
  listSuggestions(state?: SuggestionState): Suggestion[] {
    return state === undefined ? this.querySuggestions("") : this.querySuggestions("WHERE g.state = ?", state);
  }

  getSuggestion(id: number): Suggestion | null {
    return this.querySuggestions("WHERE g.id = ?", id)[0] ?? null;
  }

  markAccepted(id: number, at: Date, installedFiles: readonly string[]): void {
    this.db.run(
      "UPDATE suggestions SET state = 'Accepted', accepted_at = ?, installed_files = ? WHERE id = ?",
      at.toISOString(),
      JSON.stringify(installedFiles),
      id,
    );
  }

  markRejected(id: number, at: Date): void {
    this.db.run("UPDATE suggestions SET state = 'Rejected', rejected_at = ? WHERE id = ?", at.toISOString(), id);
  }

  private querySuggestions(where: string, ...params: SqlValue[]): Suggestion[] {
    const rows = this.db.all<{
      id: number;
      kind: string;
      state: string;
      cluster_id: number | null;
      cluster_name: string | null;
      correction_cluster_id: number | null;
      correction_cluster_name: string | null;
      workflow_name: string | null;
      title: string;
      trigger: string;
      body: string;
      scope_kind: string;
      scope_root: string | null;
      scope_name: string | null;
      created_at: string;
      accepted_at: string | null;
      rejected_at: string | null;
      installed_files: string;
    }>(
      `SELECT g.*, c.name AS cluster_name, cc.name AS correction_cluster_name
         FROM suggestions g
         LEFT JOIN clusters c ON c.id = g.cluster_id
         LEFT JOIN correction_clusters cc ON cc.id = g.correction_cluster_id
        ${where}
        ORDER BY g.id`,
      ...params,
    );
    return rows.map((row): Suggestion => {
      const evidence = this.db
        .all<{
          task_title: string;
          task_at: string;
          session_id: string;
          harness: string;
          project_root: string | null;
          project_name: string | null;
          correction_text: string | null;
          correction_at: string | null;
        }>("SELECT * FROM suggestion_evidence WHERE suggestion_id = ? ORDER BY position", row.id)
        .map(
          (e): Evidence => ({
            ...(e.correction_text !== null && e.correction_at !== null
              ? { correction: { text: e.correction_text, at: e.correction_at } }
              : {}),
            task: { title: e.task_title, at: e.task_at },
            session: { id: e.session_id, harness: e.harness as HarnessId },
            project: e.project_root && e.project_name ? { name: e.project_name, path: e.project_root } : null,
          }),
        );
      const scope: Scope =
        row.scope_kind === "project" && row.scope_root && row.scope_name
          ? { kind: "project", project: { name: row.scope_name, path: row.scope_root } }
          : { kind: "user" };
      const body = JSON.parse(row.body) as { steps?: string[]; rule?: string };
      const base = {
        id: row.id,
        state: row.state as SuggestionState,
        title: row.title,
        evidence,
        scope,
        createdAt: row.created_at,
        acceptedAt: row.accepted_at,
        rejectedAt: row.rejected_at,
        installedFiles: JSON.parse(row.installed_files) as string[],
      };
      const sourceName = row.workflow_name ?? row.title;
      if (row.kind === "rule") {
        return {
          ...base,
          kind: "rule",
          rule: body.rule ?? "",
          correctionCluster:
            row.correction_cluster_id === null
              ? null
              : { id: row.correction_cluster_id, name: row.correction_cluster_name ?? sourceName },
        };
      }
      return {
        ...base,
        kind: "skill",
        trigger: row.trigger,
        steps: body.steps ?? [],
        workflow: row.cluster_id === null ? null : { id: row.cluster_id, name: row.cluster_name ?? sourceName },
      };
    });
  }

  /** Corrections with no embedding from `modelId` yet, with their text. */
  correctionsToEmbed(modelId: string): { key: number; text: string }[] {
    return this.db
      .all<{ id: number; text: string }>(
        `SELECT m.id, m.text FROM user_messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.intent = 'Correction' AND (m.embedding IS NULL OR m.embedding_model IS NOT ?)
          ORDER BY s.started_at, s.id, m.position`,
        modelId,
      )
      .map((m) => ({ key: m.id, text: m.text }));
  }

  saveCorrectionEmbeddings(modelId: string, embeddings: readonly { key: number; vector: readonly number[] }[]): void {
    this.db.transaction(() => {
      for (const { key, vector } of embeddings) {
        this.db.run(
          "UPDATE user_messages SET embedding = ?, embedding_model = ? WHERE id = ?",
          new Uint8Array(Float32Array.from(vector).buffer),
          modelId,
          key,
        );
      }
    });
  }

  /** Every Correction Cluster with the `modelId` embeddings of its Corrections. */
  correctionClusterVectors(modelId: string): { id: number; vectors: number[][] }[] {
    const byCluster = new Map<number, number[][]>();
    for (const row of this.db.all<{ cluster_id: number; embedding: Uint8Array | null; embedding_model: string | null }>(
      `SELECT c.id AS cluster_id, m.embedding, m.embedding_model
         FROM correction_clusters c
         LEFT JOIN user_messages m ON m.correction_cluster_id = c.id AND m.intent = 'Correction'
        ORDER BY c.id, m.id`,
    )) {
      const vectors = byCluster.get(row.cluster_id) ?? [];
      byCluster.set(row.cluster_id, vectors);
      if (row.embedding && row.embedding_model === modelId) vectors.push(decodeVector(row.embedding));
    }
    return [...byCluster].map(([id, vectors]) => ({ id, vectors }));
  }

  /** Embedded Corrections that belong to no Correction Cluster yet, oldest Session first. */
  unclusteredCorrections(modelId: string): { key: number; vector: number[] }[] {
    return this.db
      .all<{ id: number; embedding: Uint8Array }>(
        `SELECT m.id, m.embedding FROM user_messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.intent = 'Correction' AND m.correction_cluster_id IS NULL
            AND m.embedding IS NOT NULL AND m.embedding_model = ?
          ORDER BY s.started_at, s.id, m.position`,
        modelId,
      )
      .map((m) => ({ key: m.id, vector: decodeVector(m.embedding) }));
  }

  /** Puts Corrections into existing Correction Clusters or new ones, then drops Correction Clusters left empty. */
  placeCorrections(
    placements: readonly ({ task: number } & ({ cluster: number } | { newCluster: number }))[],
    at: Date,
  ): void {
    this.db.transaction(() => {
      const created = new Map<number, number>();
      for (const placement of placements) {
        let cluster: number;
        if ("cluster" in placement) cluster = placement.cluster;
        else {
          cluster = created.get(placement.newCluster) ?? this.newCluster("corrections", at);
          created.set(placement.newCluster, cluster);
        }
        this.db.run("UPDATE user_messages SET correction_cluster_id = ? WHERE id = ?", cluster, placement.task);
      }
      this.db.run(
        `DELETE FROM correction_clusters WHERE id NOT IN
           (SELECT correction_cluster_id FROM user_messages WHERE correction_cluster_id IS NOT NULL AND intent = 'Correction')`,
      );
    });
  }

  /** Correction Clusters not named yet that have at least `minCorrections` Corrections, with their text. */
  unnamedCorrectionClusters(minCorrections: number): { id: number; corrections: string[] }[] {
    return this.db
      .all<{ id: number }>(
        `SELECT c.id FROM correction_clusters c
          WHERE c.name IS NULL
            AND (SELECT COUNT(*) FROM user_messages m WHERE m.correction_cluster_id = c.id AND m.intent = 'Correction') >= ?
          ORDER BY c.id`,
        minCorrections,
      )
      .map((c) => ({
        id: c.id,
        corrections: this.db
          .all<{ text: string }>(
            "SELECT text FROM user_messages WHERE correction_cluster_id = ? AND intent = 'Correction' ORDER BY id",
            c.id,
          )
          .map((m) => m.text),
      }));
  }

  nameCorrectionCluster(id: number, name: string): void {
    this.db.run("UPDATE correction_clusters SET name = ? WHERE id = ?", name, id);
  }

  /** Every Correction Cluster with its Corrections, oldest first. */
  listCorrectionClusters(): StoredCorrectionCluster[] {
    const clusters = new Map<number, StoredCorrectionCluster>();
    for (const row of this.db.all<{
      cluster_id: number;
      name: string | null;
      text: string;
      task: string;
      task_at: string;
      session_id: string;
      harness: string;
      project_name: string | null;
      project_root: string | null;
      at: string;
    }>(
      `SELECT c.id AS cluster_id, c.name, m.text, t.title AS task, s.external_id AS session_id, s.harness,
              COALESCE((SELECT MIN(f.timestamp) FROM user_messages f WHERE f.task_id = t.id), s.started_at) AS task_at,
              p.name AS project_name, p.root AS project_root, m.timestamp AS at
         FROM correction_clusters c
         JOIN user_messages m ON m.correction_cluster_id = c.id AND m.intent = 'Correction'
         JOIN tasks t ON t.id = m.task_id
         JOIN sessions s ON s.id = m.session_id
         LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY c.id, m.timestamp, s.id, m.position`,
    )) {
      const cluster = clusters.get(row.cluster_id) ?? { id: row.cluster_id, name: row.name, corrections: [] };
      clusters.set(row.cluster_id, cluster);
      cluster.corrections.push({
        text: row.text,
        task: row.task,
        taskAt: row.task_at,
        session: row.session_id,
        harness: row.harness as HarnessId,
        project: row.project_root && row.project_name ? { name: row.project_name, path: row.project_root } : null,
        at: row.at,
      });
    }
    return [...clusters.values()];
  }

  /** Every User Message of an analyzed Session, with its Intent and when it was sent, oldest first. */
  analyzedUserMessages(): AnalyzedUserMessage[] {
    return this.db
      .all<{ at: string; intent: string; project_name: string | null; project_root: string | null }>(
        `SELECT m.timestamp AS at, m.intent, p.name AS project_name, p.root AS project_root
           FROM user_messages m
           JOIN sessions s ON s.id = m.session_id
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE m.task_id IS NOT NULL AND m.intent IS NOT NULL
          ORDER BY m.timestamp, m.id`,
      )
      .map((m) => ({
        at: m.at,
        intent: m.intent as Intent,
        project: m.project_root && m.project_name ? { name: m.project_name, path: m.project_root } : null,
      }));
  }

  private userMessageTexts(sessionKey: number): string[] {
    return this.db
      .all<{ text: string }>("SELECT text FROM user_messages WHERE session_id = ? ORDER BY position", sessionKey)
      .map((m) => m.text);
  }

  private projectId(project: ResolvedProject): number {
    this.db.run("INSERT INTO projects (root, name) VALUES (?, ?) ON CONFLICT (root) DO NOTHING", project.root, project.name);
    const row = this.db.get<{ id: number }>("SELECT id FROM projects WHERE root = ?", project.root);
    if (!row) throw new Error(`Project ${project.root} was not stored`);
    return row.id;
  }
}

function decodeVector(blob: Uint8Array): number[] {
  // Copy first: the blob's bytes need not be aligned for a Float32Array view.
  return Array.from(new Float32Array(blob.slice().buffer));
}

/** The per-Session summary columns, in the order the session queries list them. */
function summaryValues(session: HarnessSession): number[] {
  const { tokens } = session;
  return [session.assistantTurnCount, session.subagentRunCount, tokens.input, tokens.output, tokens.cacheCreation, tokens.cacheRead];
}
