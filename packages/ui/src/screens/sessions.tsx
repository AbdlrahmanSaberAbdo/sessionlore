import type { BrowseFilter, SessionList, SessionTaskView, SessionView, SessionViewMessage } from "@sessionlore/core";
import { Fragment } from "react";
import { FilterBar, harnessName, plural } from "../components/filters.js";
import { Link, sessionPath } from "../router.js";

/** Sessions, latest first, each opening the Session viewer. */
export function SessionsScreen({ list, filter }: { list: SessionList; filter: BrowseFilter }) {
  return (
    <>
      <h1>Sessions</h1>
      <FilterBar filter={filter} options={list.filters} />
      <section className="panel">
        {list.sessions.length === 0 ? (
          <p className="muted">No Sessions{Object.keys(filter).length > 0 ? " match these filters" : " yet. Run sessionlore scan"}.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Started</th>
                <th>Project</th>
                <th>Harness</th>
                <th>User Messages</th>
              </tr>
            </thead>
            <tbody>
              {list.sessions.map((s) => (
                <tr key={`${s.harness}-${s.id}`}>
                  <td>
                    <Link href={sessionPath(s.id)}>{s.startedAt.slice(0, 16).replace("T", " ")}</Link>
                  </td>
                  <td>{s.project?.name ?? <span className="muted">none</span>}</td>
                  <td>{harnessName(s.harness)}</td>
                  <td>{s.userMessageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** One Session's messages, with a marker where each Task starts and Corrections highlighted. */
export function SessionScreen({ session }: { session: SessionView }) {
  const tasks = new Map(session.tasks.map((t) => [t.position, t]));
  let previous: number | null = null;
  return (
    <>
      <p className="muted">
        <Link href="/sessions">Sessions</Link> /
      </p>
      <h1>{session.project?.name ?? "Session"}</h1>
      <p className="muted">
        {harnessName(session.harness)} · {session.startedAt.slice(0, 16).replace("T", " ")} ·{" "}
        {plural(session.userMessageCount, "User Message")}
        {session.tasks.length > 0 ? ` · ${plural(session.tasks.length, "Task")}` : " · not analyzed yet"}
      </p>
      <section className="transcript">
        {session.messages.map((message, i) => {
          const task = message.task !== null && message.task !== previous ? tasks.get(message.task) : undefined;
          previous = message.task;
          return (
            <Fragment key={i}>
              {task ? <TaskBoundary task={task} /> : null}
              <Message message={message} />
            </Fragment>
          );
        })}
      </section>
    </>
  );
}

function TaskBoundary({ task }: { task: SessionTaskView }) {
  return (
    <div className="task-boundary" id={`task-${task.position}`}>
      <span className="task-title">
        Task {task.position + 1}: {task.title}
      </span>
      {task.workflow ? <Link href={`/workflows/${task.workflow.id}`}>{task.workflow.name}</Link> : null}
      {task.corrections > 0 ? <span className="correction-count">{plural(task.corrections, "Correction")}</span> : null}
    </div>
  );
}

function Message({ message }: { message: SessionViewMessage }) {
  if (message.role === "tool") {
    return (
      <div className="message tool">
        <code>{message.name}</code> {message.status ? <span className="muted">{message.status}</span> : null}
      </div>
    );
  }
  const correction = message.intent === "Correction";
  const className = ["message", message.role, correction ? "correction" : null].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <div className="who">
        {message.role === "user" ? "You" : message.subagent ? `Agent (${message.subagent})` : "Agent"}
        {message.intent ? <span className={correction ? "intent correction-label" : "intent"}>{message.intent}</span> : null}
      </div>
      <div className="text">{message.text}</div>
    </div>
  );
}
