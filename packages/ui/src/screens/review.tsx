import type { ReviewQueue, Scope, ScopeChoice, SuggestionForm, SuggestionReview } from "@habitlore/core";
import { useState } from "react";
import { harnessName, plural } from "../components/filters.js";
import { Link, sessionPath, suggestionPath } from "../router.js";

/** The review queue: Pending Suggestions with their kind, Scope and Evidence count. */
export function ReviewQueueScreen({ queue }: { queue: ReviewQueue }) {
  return (
    <>
      <h1>Review</h1>
      <section className="panel">
        {queue.suggestions.length === 0 ? (
          <p className="muted">
            No Pending Suggestions. Run <code>habitlore suggest</code> to write some.
          </p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Suggestion</th>
                <th>Kind</th>
                <th>Scope</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {queue.suggestions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={suggestionPath(s.id)}>{s.title}</Link>
                    {s.target ? <div className="muted small">Updates {s.target.path}</div> : null}
                  </td>
                  <td>{kindName(s.kind)}</td>
                  <td>{scopeName(s.scope)}</td>
                  <td>{s.kind === "skill" ? plural(s.evidence, "Task") : plural(s.evidence, "Correction")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
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
      <p className="muted">
        <Link href="/suggestions">Review</Link> /
      </p>
      <h1>{suggestion.title}</h1>
      <p className="muted">
        {kindName(suggestion.kind)} · <span className={`state ${suggestion.state.toLowerCase()}`}>{suggestion.state}</span> ·{" "}
        {scopeName(suggestion.scope)}
        {suggestion.target ? ` · updates ${suggestion.target.path}` : ""}
      </p>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {pending ? (
        <section className="panel actions">
          <button type="button" className="primary" disabled={busy || review.changesError !== null} onClick={() => run(actions.accept)}>
            Accept
          </button>
          <button type="button" disabled={busy} onClick={() => run(actions.reject)}>
            Reject
          </button>
          <ScopePicker review={review} disabled={busy} onChange={(choice) => run(() => actions.setScope(choice))} />
        </section>
      ) : null}
      <section className="panel">
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
        <section className="panel">
          <h2>Edit</h2>
          <EditForm key={JSON.stringify(review.form)} form={review.form} disabled={busy} onSave={(form) => run(() => actions.save(form))} />
        </section>
      ) : null}
      <section className="panel">
        <h2>Evidence</h2>
        <ul className="plain evidence">
          {review.evidence.map((e, i) => (
            <li key={i}>
              <span className="muted small">{(e.correction?.at ?? e.task.at).slice(0, 10)}</span>{" "}
              <Link href={sessionPath(e.session.id, e.taskPosition)}>{e.correction ? `“${e.correction.text}”` : e.task.title}</Link>
              <span className="muted small">
                {e.correction ? ` in ${e.task.title}` : ""} · {harnessName(e.session.harness)}
                {e.project ? ` · ${e.project.name}` : ""}
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
