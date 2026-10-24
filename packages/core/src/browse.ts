import type { Intent, RepeatRule } from "@sessionlore/analysis";
import type { HarnessId } from "./adapter.js";
import type { ClusterTask, StoredMessage, StoredSession } from "./store/store.js";
import type { ProjectRef, SuggestionState } from "./suggestion.js";

/**
 * What the dashboard's Workflows screen and Session viewer show, and the
 * filters both share.
 */

/** Narrows Workflows' Tasks and Sessions. Every field is optional; an empty filter keeps everything. */
export interface BrowseFilter {
  /** A Project's root folder. */
  project?: string;
  harness?: HarnessId;
  /** First day kept, `YYYY-MM-DD` (UTC). */
  from?: string;
  /** Last day kept, `YYYY-MM-DD` (UTC), inclusive. */
  to?: string;
}

/** The values the filters can take: the Projects and Harnesses of the Sessions that may be shown. */
export interface FilterOptions {
  projects: ProjectRef[];
  harnesses: HarnessId[];
}

export interface SuggestionRef {
  id: number;
  state: SuggestionState;
}

/** A Workflow as the Workflows screen lists it, counted within the filter. */
export interface WorkflowSummary {
  id: number;
  name: string;
  tasks: number;
  sessions: number;
  harnesses: HarnessId[];
  projects: ProjectRef[];
  /** Its latest Suggestion, if it has one. */
  suggestion: SuggestionRef | null;
}

export interface NearWorkflowSummary extends WorkflowSummary {
  /** How many more Tasks and Sessions inside the Repeat Rule's window it needs to become a Workflow. */
  needs: { tasks: number; sessions: number };
}

export interface WorkflowList {
  repeatRule: RepeatRule;
  workflows: WorkflowSummary[];
  nearWorkflows: NearWorkflowSummary[];
  filters: FilterOptions;
}

/** One Workflow (or near-Workflow) with its Tasks within the filter. */
export interface WorkflowDetail {
  id: number;
  name: string;
  /** False for a near-Workflow. */
  passesRepeatRule: boolean;
  tasks: ClusterTask[];
  sessions: number;
  harnesses: HarnessId[];
  suggestions: (SuggestionRef & { title: string })[];
  filters: FilterOptions;
}

export interface SessionList {
  /** Latest first. */
  sessions: StoredSession[];
  filters: FilterOptions;
}

/** A Session's message, with the Task it belongs to once the Session is analyzed. */
export type SessionViewMessage = StoredMessage & {
  /** Position of its Task in `SessionView.tasks`; agent replies belong to the Task of the User Message before them. */
  task: number | null;
  /** Set on User Messages of an analyzed Session. */
  intent?: Intent;
};

export interface SessionTaskView {
  position: number;
  title: string;
  /** The Workflow (or near-Workflow) the Task is in, if any. */
  workflow: { id: number; name: string } | null;
  corrections: number;
}

/** One Session for the Session viewer: its messages with Task boundaries and Corrections. */
export interface SessionView extends StoredSession {
  tasks: SessionTaskView[];
  messages: SessionViewMessage[];
}

export function matchesFilter(
  filter: BrowseFilter,
  item: { harness: HarnessId; project: ProjectRef | null; at: string },
): boolean {
  if (filter.harness && item.harness !== filter.harness) return false;
  if (filter.project && item.project?.path !== filter.project) return false;
  const day = item.at.slice(0, 10);
  if (filter.from && day < filter.from) return false;
  if (filter.to && day > filter.to) return false;
  return true;
}

export function filterOptions(sessions: readonly StoredSession[]): FilterOptions {
  const projects = new Map<string, ProjectRef>();
  for (const s of sessions) if (s.project) projects.set(s.project.path, { name: s.project.name, path: s.project.path });
  return {
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    harnesses: [...new Set(sessions.map((s) => s.harness))].sort(),
  };
}

/** Distinct values in first-seen order, compared by `key`. */
export function distinct<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}
