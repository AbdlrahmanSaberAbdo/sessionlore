import type { ReviewQueue, ReviewQueueItem, Scope, ScopeChoice, SuggestionForm, SuggestionReview } from "@sessionlore/core";
import { useState } from "react";
import { harnessName, plural } from "../components/filters.js";
import { Link, sessionPath, suggestionPath } from "../router.js";

/**
 * Home for now: the Pending Suggestions, Skills then Rules, each opening its
 * review page. The full Home (the most repeated Correction, reasons, the
 * Repeat Rule strip) replaces this.
 */
export function PendingScreen({ queue }: { queue: ReviewQueue }) {
  const skills = queue.suggestions.filter((s) => s.kind === "skill");
  const rules = queue.suggestions.filter((s) => s.kind === "rule");
  const count = queue.suggestions.length;
  return (
    <>
      <header className="page-head">
        <h1>{count === 0 ? "Nothing to review" : `${count} to review`}</h1>
        <p className="lede">
          {count === 0 ? (
            <>
              No Pending Suggestions. Run <code>sessionlore suggest</code> to write some from your analyzed Sessions.
            </>
          ) : (
            "Suggestions drafted from what you repeat in your Sessions. Nothing changes until you accept one."
          )}
        </p>
      </header>
      {skills.length > 0 ? (
        <section className="section">
          <h2>Skills</h2>
          <p className="explain">Procedures for things you keep asking your agents to do.</p>
          <PendingList suggestions={skills} />
        </section>
      ) : null}
      {rules.length > 0 ? (
        <section className="section">
          <h2>Rules</h2>
          <p className="explain">One-line instructions for things you keep correcting.</p>
          <PendingList suggestions={rules} />
        </section>
      ) : null}
    </>
  );
}

function PendingList({ suggestions }: { suggestions: ReviewQueueItem[] }) {
  return (
    <ul className="marks">
      {suggestions.map((s) => (
        <li key={s.id} className={s.kind}>
          <Link href={suggestionPath(s.id)} className="title">
            {s.title}
          </Link>
          <span className="reason">
            {s.kind === "skill" ? `Seen in ${plural(s.evidence, "Task")}` : `From ${plural(s.evidence, "Correction")}`}, for{" "}
            {scopeName(s.scope)}.
          </span>
          {s.target ? <span className="reason small">Updates {s.target.path}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** What the review screen asks the server to do; each resolves once it is done. */
export interface ReviewActions {
  save(form: SuggestionForm): Promise<void>;
  setScope(choice: ScopeChoice): Promise<void>;
  accept(): Promise<void>;
  reject(): Promise<void>;
}

/** One Suggestion: what accepting will write (or the diff against its Target), its Evidence, and the review actions. */
export function ReviewScreen({
  review,
  actions,
  notice,
  error,
}: {
  review: SuggestionReview;
  actions: ReviewActions;
  /** What the last action did, e.g. the files accepting wrote. */
  notice?: string | null;
  /** Why the last action failed. */
  error?: string | null;
}) {
  const { suggestion } = review;
  const pending = suggestion.state === "Pending";
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    action().finally(() => setBusy(false));
  };
  return (
    <>
      <header className="page-head">
        <p className="crumb">
          <Link href="/">Home</Link>
        </p>
        <p className={`kind-line ${suggestion.kind}`}>
          {kindName(suggestion.kind)}, {suggestion.state}, for {scopeName(suggestion.scope)}
          {suggestion.target ? `, updates ${suggestion.target.path}` : ""}
        </p>
        <h1>{suggestion.title}</h1>
      </header>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {pending ? (
        <section className="actions" aria-label="Review">
          <button type="button" className="primary" disabled={busy || review.changesError !== null} onClick={() => run(actions.accept)}>
            Accept
          </button>
          <button type="button" disabled={busy} onClick={() => run(actions.reject)}>
            Reject
          </button>
          <ScopePicker review={review} disabled={busy} onChange={(choice) => run(() => actions.setScope(choice))} />
        </section>
      ) : null}
      <section className="section">
        <h2>{suggestion.target ? "Changes" : "What accepting writes"}</h2>
        {review.changesError ? <p className="error">Accepting would fail: {review.changesError}</p> : null}
        {review.changes ? (
          review.changes.map((change) => (
            <div key={change.path} className="file">
              <div className="file-path">
                {change.path} {change.before === null ? <span className="muted">(new file)</span> : null}
              </div>
              {change.before === null ? <pre className="content">{change.after}</pre> : <Diff diff={change.diff} />}
            </div>
          ))
        ) : review.changesError ? null : (
          <InstalledFiles files={suggestion.installedFiles} />
        )}
      </section>
      {review.form ? (
        <section className="section">
          <h2>Edit</h2>
          <EditForm key={JSON.stringify(review.form)} form={review.form} disabled={busy} onSave={(form) => run(() => actions.save(form))} />
        </section>
      ) : null}
      <section className="section">
        <h2>Evidence</h2>
        <ul className="plain evidence">
          {review.evidence.map((e, i) => (
            <li key={i}>
              <time dateTime={e.correction?.at ?? e.task.at}>{(e.correction?.at ?? e.task.at).slice(0, 10)}</time>
              <Link href={sessionPath(e.session.id, e.taskPosition)} className={e.correction ? "correction" : undefined}>
                {e.correction ? `“${e.correction.text}”` : e.task.title}
              </Link>
              <span className="where">
                {e.correction ? `In ${e.task.title}, ` : ""}
                {harnessName(e.session.harness)}
                {e.project ? `, ${e.project.name}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function InstalledFiles({ files }: { files: string[] }) {
  if (files.length === 0) return <p className="muted">Nothing was written.</p>;
  return (
    <ul className="plain">
      {files.map((f) => (
        <li key={f}>
          <code>{f}</code>
        </li>
      ))}
    </ul>
  );
}

/** A unified diff, its added and removed lines marked. */
function Diff({ diff }: { diff: string }) {
  if (diff === "") return <p className="muted">No change.</p>;
  return (
    <pre className="diff">
      {diff.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "meta" : "";
        return (
          <span key={i} className={kind}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

/** User scope, or Project scope in one of the known Projects. */
function ScopePicker({ review, disabled, onChange }: { review: SuggestionReview; disabled: boolean; onChange(choice: ScopeChoice): void }) {
  const { scope } = review.suggestion;
  const projects = [...review.projects];
  if (scope.kind === "project" && !projects.some((p) => p.path === scope.project.path)) projects.push(scope.project);
  return (
    <label>
      Scope{" "}
      <select
        value={scope.kind === "user" ? "" : scope.project.path}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? { kind: "project", folder: e.target.value } : { kind: "user" })}
      >
        <option value="">User scope (all your work)</option>
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            Project scope: {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The Suggestion's editable fields: text, or a list of text edited one item per line. */
function EditForm({ form, disabled, onSave }: { form: SuggestionForm; disabled: boolean; onSave(form: SuggestionForm): void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : (v ?? "")])),
  );
  const changed = Object.keys(form).some((k) => draft[k] !== (Array.isArray(form[k]) ? (form[k] as string[]).join("\n") : form[k]));
  return (
    <form
      className="edit"
      onSubmit={(event) => {
        event.preventDefault();
        const edited = Object.fromEntries(
          Object.keys(form).map((k) => [k, Array.isArray(form[k]) ? draft[k]!.split("\n").filter((line) => line.trim() !== "") : draft[k]!]),
        );
        onSave(edited as SuggestionForm);
      }}
    >
      {Object.keys(form).map((field) => (
        <label key={field}>
          {fieldName(field)}
          {Array.isArray(form[field]) ? <span className="muted small"> (one per line)</span> : null}
          {field === "title" ? (
            <input value={draft[field]} disabled={disabled} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} />
          ) : (
            <textarea
              rows={Array.isArray(form[field]) ? Math.max(3, (form[field] as string[]).length + 1) : 2}
              value={draft[field]}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={disabled || !changed}>
        Save changes
      </button>
    </form>
  );
}

function fieldName(field: string): string {
  return field.charAt(0).toUpperCase() + field.slice(1);
}

function kindName(kind: string): string {
  return kind === "skill" ? "Skill" : "Rule";
}

function scopeName(scope: Scope): string {
  return scope.kind === "project" ? `Project scope (${scope.project.name})` : "User scope";
}
