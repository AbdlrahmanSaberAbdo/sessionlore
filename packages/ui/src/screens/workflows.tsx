import type { BrowseFilter, WorkflowDetail, WorkflowList, WorkflowSummary, NearWorkflowSummary } from "@sessionlore/core";
import { FilterBar, harnessName, plural } from "../components/filters.js";
import { filterQuery, Link, sessionPath, suggestionPath } from "../router.js";

/** Workflows and near-Workflows, with their Tasks, Sessions, Harnesses and Suggestion state. */
export function WorkflowsScreen({ list, filter }: { list: WorkflowList; filter: BrowseFilter }) {
  const query = filterQuery(filter);
  return (
    <>
      <header className="page-head">
        <h1>Workflows</h1>
        <p className="lede">
          Similar Tasks you repeat: at least {list.repeatRule.minMembers} across {list.repeatRule.minSessions} Sessions within{" "}
          {list.repeatRule.windowDays} days. Each one can become a Skill.
        </p>
        <FilterBar filter={filter} options={list.filters} />
      </header>
      <section className="section">
        {list.workflows.length === 0 ? (
          <p className="empty">
            No Workflows{query ? " match these filters" : " yet"}: a Workflow needs at least {list.repeatRule.minMembers} similar
            Tasks across {list.repeatRule.minSessions} Sessions within {list.repeatRule.windowDays} days.
          </p>
        ) : (
          <WorkflowTable workflows={list.workflows} query={query} />
        )}
      </section>
      {list.nearWorkflows.length > 0 ? (
        <section className="section">
          <h2>Near-Workflows</h2>
          <p className="explain">Close to repeating often enough to become a Workflow.</p>
          <WorkflowTable workflows={list.nearWorkflows} query={query} />
        </section>
      ) : null}
    </>
  );
}

function WorkflowTable({ workflows, query }: { workflows: (WorkflowSummary | NearWorkflowSummary)[]; query: string }) {
  return (
    <div className="table-wrap">
    <table className="list">
      <thead>
        <tr>
          <th>Name</th>
          <th>Tasks</th>
          <th>Sessions</th>
          <th>Harnesses</th>
          <th title="Corrections per Task">Corr./Task</th>
          <th>Suggestion</th>
        </tr>
      </thead>
      <tbody>
        {workflows.map((w) => (
          <tr key={w.id}>
            <td>
              <Link href={`/workflows/${w.id}${query}`}>{w.name}</Link>
              {"needs" in w ? <div className="muted small">{needsText(w.needs)}</div> : null}
              {w.projects.length > 0 ? <div className="muted small">{w.projects.map((p) => p.name).join(", ")}</div> : null}
            </td>
            <td>{plural(w.tasks, "Task")}</td>
            <td>{plural(w.sessions, "Session")}</td>
            <td>{w.harnesses.map(harnessName).join(", ")}</td>
            <td>{perTask(w.correctionsPerTask)}</td>
            <td>{w.suggestion ? <span className={`state ${w.suggestion.state.toLowerCase()}`}>{w.suggestion.state}</span> : <span className="muted">None</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function perTask(value: number | null): string {
  return value === null ? "–" : value.toFixed(2);
}

function needsText(needs: NearWorkflowSummary["needs"]): string {
  const parts = [
    needs.tasks > 0 ? `${needs.tasks} more ${needs.tasks === 1 ? "Task" : "Tasks"}` : null,
    needs.sessions > 0 ? `${needs.sessions} more ${needs.sessions === 1 ? "Session" : "Sessions"}` : null,
  ].filter(Boolean);
  return `needs ${parts.join(" and ")}`;
}

/** One Workflow's Tasks, each linking to where it is in its Session. */
export function WorkflowScreen({ workflow, filter }: { workflow: WorkflowDetail; filter: BrowseFilter }) {
  return (
    <>
      <header className="page-head">
        <p className="crumb">
          <Link href={`/workflows${filterQuery(filter)}`}>Workflows</Link>
        </p>
        <h1>{workflow.name}</h1>
        <p className="lede">
          {workflow.passesRepeatRule ? "A Workflow" : "A Near-Workflow"}: {plural(workflow.tasks.length, "Task")} in{" "}
          {plural(workflow.sessions, "Session")} with {workflow.harnesses.map(harnessName).join(" and ")}, and{" "}
          {perTask(workflow.correctionsPerTask.overall)} Corrections per Task.
        </p>
        <FilterBar filter={filter} options={workflow.filters} />
      </header>
      {workflow.suggestions.length > 0 ? (
        <section className="section">
          <h2>Suggestions</h2>
          <ul className="marks">
            {workflow.suggestions.map((s) => (
              <li key={s.id} className="skill">
                <Link href={suggestionPath(s.id)} className="title">
                  {s.title}
                </Link>
                <span className={`state ${s.state.toLowerCase()}`}>{s.state}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="section">
        <h2>Tasks</h2>
        {workflow.tasks.length === 0 ? (
          <p className="empty">No Tasks match these filters.</p>
        ) : (
          <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>Harness</th>
                <th>Corrections</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {workflow.tasks.map((t) => (
                <tr key={`${t.session}-${t.position}`}>
                  <td>
                    <Link href={sessionPath(t.session, t.position)}>{t.title}</Link>
                  </td>
                  <td>{t.project?.name ?? <span className="muted">none</span>}</td>
                  <td>{harnessName(t.harness)}</td>
                  <td>{t.corrections}</td>
                  <td>{t.at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </>
  );
}
