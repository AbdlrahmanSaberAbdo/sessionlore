import type { HarnessId } from "./adapter.js";

/**
 * Suggestions in their format-neutral form (ADR 0005), and the Renderer
 * interface that turns one into a Harness's files when it is Accepted.
 */

/** Skills come from Workflows, Rules from Correction Clusters. */
export type SuggestionKind = "skill" | "rule";

export const suggestionStates = ["Pending", "Accepted", "Rejected"] as const;
export type SuggestionState = (typeof suggestionStates)[number];

export interface ProjectRef {
  name: string;
  /** The Project's root folder. */
  path: string;
}

/** Where an Accepted Suggestion is installed. */
export type Scope = { kind: "project"; project: ProjectRef } | { kind: "user" };

/**
 * One Task or Correction a Suggestion was derived from, linked to its Session.
 * A Skill's Evidence is Tasks; a Rule's is Corrections, each with its Task.
 */
export interface Evidence {
  /** `at`: when the Task started. Together with the Session it identifies the Task. */
  task: { title: string; at: string };
  session: { id: string; harness: HarnessId };
  project: ProjectRef | null;
  /** Set when the Evidence is a Correction: its text and timestamp. */
  correction?: { text: string; at: string };
}

interface SuggestionBase {
  id: number;
  kind: SuggestionKind;
  state: SuggestionState;
  title: string;
  evidence: Evidence[];
  scope: Scope;
  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  /** Files written when it was Accepted. */
  installedFiles: string[];
  /** The existing Skill or Rule it updates; null when it creates something new. */
  target: Target | null;
}

/**
 * An existing Skill or Rule the person owns that a Suggestion updates. A
 * Skill Target is its `SKILL.md`; a Rule Target is one line of a `CLAUDE.md`.
 */
export type Target = { kind: "skill"; path: string; name: string } | { kind: "rule"; path: string; line: string };

/** A plugin skill a companion Skill works alongside. Plugin skills are never Targets. */
export interface PluginSkillRef {
  plugin: string;
  name: string;
}

export interface SkillSuggestion extends SuggestionBase {
  kind: "skill";
  /** When an agent should use it. */
  trigger: string;
  steps: string[];
  /** The Workflow it came from; null once that Workflow no longer exists. */
  workflow: { id: number; name: string } | null;
  /** Set when a plugin skill already covers part of the Workflow and this Skill complements it. */
  companionOf: PluginSkillRef | null;
}

export interface RuleSuggestion extends SuggestionBase {
  kind: "rule";
  /** The one-line standing instruction. */
  rule: string;
  /** The Correction Cluster it came from; null once that Correction Cluster no longer exists. */
  correctionCluster: { id: number; name: string } | null;
}

export type Suggestion = SkillSuggestion | RuleSuggestion;

/**
 * The default Scope for some Evidence: Project scope when all of it comes from
 * one Project, otherwise User scope.
 */
export function defaultScope(evidence: readonly Pick<Evidence, "project">[]): Scope {
  const [first] = evidence;
  const project = first?.project;
  if (!project || evidence.some((e) => e.project?.path !== project.path)) return { kind: "user" };
  return { kind: "project", project: { name: project.name, path: project.path } };
}

/** What a Renderer may look at besides the Suggestion. It never writes; the caller does. */
export interface RenderContext {
  /** The person's home directory, where User scope files live. */
  homeDir: string;
  /** The current content of a file, or null when it doesn't exist. */
  readFile(path: string): string | null;
}

/** What a Renderer may look at when listing what is installed. */
export interface InstalledContext extends RenderContext {
  /** Projects whose own files count, besides the User scope ones. */
  projects: readonly ProjectRef[];
  /** Entries of a folder, or [] when it doesn't exist. */
  listDir(path: string): { name: string; isDirectory: boolean }[];
}

/**
 * A Skill or Rule already installed in a Harness, read before suggesting so
 * nothing is proposed twice. `plugin` is set for a plugin skill, which is
 * only ever looked at for overlap.
 */
export type InstalledItem =
  | { kind: "skill"; path: string; name: string; description: string; content: string; plugin: string | null }
  | { kind: "rule"; path: string; line: string };

/** A whole file a Renderer wants written: its absolute path and complete new content. */
export interface RenderedFile {
  path: string;
  content: string;
}

/** A Suggestion can't be rendered as it stands, e.g. because it would overwrite a file the person owns. */
export class RenderError extends Error {
  override name = "RenderError";
}

/**
 * Turns one kind of Suggestion into one Harness's file format. Rendering is
 * pure, so the same output serves as the preview of what accepting will write.
 */
export interface Renderer {
  /** Stable identifier, e.g. "claude-skill". */
  readonly id: string;
  readonly harness: HarnessId;
  readonly kind: SuggestionKind;
  /** Throws RenderError when the Suggestion can't be installed. */
  render(suggestion: Suggestion, context: RenderContext): RenderedFile[];
  /** The installed Skills or Rules of this Renderer's kind and Harness. Reads only. */
  installed?(context: InstalledContext): InstalledItem[];
}
