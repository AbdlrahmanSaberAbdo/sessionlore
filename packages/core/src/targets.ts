import { join, sep } from "node:path";
import type { Embedder } from "./ports.js";
import type {
  Evidence,
  InstalledContext,
  InstalledItem,
  ProjectRef,
  Renderer,
  Scope,
  Suggestion,
  SuggestionKind,
  Target,
} from "./suggestion.js";

/**
 * Finding the installed Skills and Rules a new Suggestion overlaps, so it
 * updates them (its Target) instead of duplicating them.
 */

/**
 * How similar an installed Skill or Rule must be to a Workflow or Correction
 * Cluster's name to count as covering the same ground. Lower than the Cluster
 * threshold: a skill's description and a Workflow's name are worded differently.
 */
export const TARGET_SIMILARITY = 0.6;

/** Reads what is installed once per set of Projects, and embeds each text once per `suggest`. */
export class Overlaps {
  private readonly vectors = new Map<string, number[]>();

  constructor(
    private readonly renderers: readonly Renderer[],
    private readonly context: (projects: readonly ProjectRef[]) => InstalledContext,
    private readonly embedder: Embedder | undefined,
  ) {}

  /**
   * Installed items of `kind` (in the Evidence's Projects or User scope) that
   * cover what `text` describes, most similar first. None without an Embedder.
   */
  async find(kind: SuggestionKind, text: string, evidence: readonly Evidence[], updates?: Suggestion): Promise<InstalledItem[]> {
    const installed = updates && this.installedBy(updates);
    if (installed) return [installed];
    if (!this.embedder) return [];
    const projects = evidenceProjects(evidence);
    const context = this.context(projects);
    const items = this.renderers.filter((r) => r.kind === kind).flatMap((r) => r.installed?.(context) ?? []);
    if (items.length === 0) return [];
    const texts = items.map(itemText);
    await this.embed([text, ...texts]);
    const query = this.vectors.get(text)!;
    return items
      .map((item, i) => ({ item, score: cosine(query, this.vectors.get(texts[i]!)!) }))
      .filter((s) => s.score >= TARGET_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.item);
  }

  /**
   * The installed Skill or Rule an Accepted Suggestion put in place, if it is
   * still there: an item in one of the files it wrote (for a Rule, the line
   * holding its text).
   */
  installedBy(accepted: Suggestion): InstalledItem | undefined {
    const projects = evidenceProjects(accepted.evidence);
    if (accepted.scope.kind === "project") projects.push(accepted.scope.project);
    const context = this.context(projects);
    const files = new Set(accepted.installedFiles);
    return this.renderers
      .filter((r) => r.kind === accepted.kind)
      .flatMap((r) => r.installed?.(context) ?? [])
      .find((item) => {
        if (!files.has(item.path)) return false;
        if (item.kind === "skill") return item.plugin === null;
        return accepted.kind === "rule" && item.line.includes(accepted.rule);
      });
  }

  private async embed(texts: readonly string[]): Promise<void> {
    const missing = [...new Set(texts.filter((t) => !this.vectors.has(t)))];
    if (missing.length === 0) return;
    const vectors = await this.embedder!.embed(missing);
    missing.forEach((t, i) => this.vectors.set(t, vectors[i]!));
  }
}

/**
 * Whether a Target lives in `scope`: inside the Project's folder, or in the
 * User scope's `~/.claude`. A Suggestion only updates a Target in its own Scope.
 */
export function targetWithin(target: Target, scope: Scope, homeDir: string): boolean {
  const root = scope.kind === "project" ? scope.project.path : join(homeDir, ".claude");
  return target.path.startsWith(root + sep);
}

/**
 * The kind-independent fields of a new Suggestion with its Target, installed
 * where the Target lives. A Scope the person chose stays, and then a Target
 * outside it is dropped: the Suggestion becomes a new Skill or Rule there.
 */
export function withTarget<T extends { scope: Scope; scopeOverridden?: boolean; evidence: readonly Evidence[] }>(
  write: T,
  target: Target | null,
  homeDir: string,
): T & { target: Target | null } {
  if (!target) return { ...write, target };
  if (write.scopeOverridden) return { ...write, target: targetWithin(target, write.scope, homeDir) ? target : null };
  const project = evidenceProjects(write.evidence).find((p) => target.path.startsWith(p.path + sep));
  const scope: Scope = project ? { kind: "project", project } : { kind: "user" };
  return { ...write, scope, target };
}

function evidenceProjects(evidence: readonly Evidence[]): ProjectRef[] {
  const projects = new Map<string, ProjectRef>();
  for (const e of evidence) if (e.project) projects.set(e.project.path, { name: e.project.name, path: e.project.path });
  return [...projects.values()];
}

function itemText(item: InstalledItem): string {
  if (item.kind === "rule") return item.line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  return `${item.name}: ${item.description}`;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
