import type { FileChange, SuggestionForm } from "./app.js";
import type { Evidence, ProjectRef, Scope, Suggestion, SuggestionKind, Target } from "./suggestion.js";

/** What the dashboard's review queue shows: Pending Suggestions, and one of them in full. */

/** A Pending Suggestion as the queue lists it. */
export interface ReviewQueueItem {
  id: number;
  kind: SuggestionKind;
  title: string;
  scope: Scope;
  /** How many Tasks or Corrections it was derived from. */
  evidence: number;
  target: Target | null;
  createdAt: string;
}

export interface ReviewQueue {
  suggestions: ReviewQueueItem[];
}

/** A piece of Evidence with the Session viewer path that shows it. */
export interface ReviewEvidence extends Evidence {
  /** `/sessions/<id>`, ending in `#task-<n>` when the Task is still in that Session. */
  link: string;
}

/** One Suggestion with everything needed to decide on it. */
export interface SuggestionReview {
  suggestion: Suggestion;
  /** Its editable content; null once it is no longer Pending. */
  form: SuggestionForm | null;
  /** What accepting would write, with a diff against each file's current content; null once it is no longer Pending. */
  changes: FileChange[] | null;
  /** Why accepting would fail as it stands, e.g. it would overwrite a file the person owns; null when it would succeed. */
  changesError: string | null;
  evidence: ReviewEvidence[];
  /** The Projects it can be scoped to. */
  projects: ProjectRef[];
}
