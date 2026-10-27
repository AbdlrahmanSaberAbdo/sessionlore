import type { SessionTaskView, SessionView, SessionViewMessage } from "@sessionlore/core";
import { Fragment } from "react";
import { harnessName, plural } from "../components/filters.js";
import { Link } from "../router.js";

/** One Session's messages, with a marker where each Task starts and Corrections highlighted. */
export function SessionScreen({ session }: { session: SessionView }) {
  const tasks = new Map(session.tasks.map((t) => [t.position, t]));
  let previous: number | null = null;
  return (
    <>
      <header className="page-head">
        <p className="crumb">Session</p>
        <h1>{session.project?.name ?? "No Project"}</h1>
        <p className="lede">
          {harnessName(session.harness)}, started {session.startedAt.slice(0, 16).replace("T", " ")}, with{" "}
          {plural(session.userMessageCount, "User Message")}
          {session.tasks.length > 0 ? ` in ${plural(session.tasks.length, "Task")}.` : ". Not analyzed yet."}
        </p>
      </header>
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
