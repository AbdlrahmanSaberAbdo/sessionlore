import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FilterOptions, Overview, SessionList, SessionView, WorkflowDetail, WorkflowList } from "@sessionlore/core";
import { OverviewScreen } from "../src/screens/overview.js";
import { SessionScreen, SessionsScreen } from "../src/screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "../src/screens/workflows.js";

/**
 * The UI's smoke test: each screen renders the data the API returns. UI logic
 * is kept thin; behaviour is tested through the API (Seam 2).
 */

const overview: Overview = {
  counts: { sessions: 12, tasks: 31, workflows: 2 },
  topWorkflows: [
    { id: 4, name: "Write database migrations", tasks: 7, sessions: 5 },
    { id: 9, name: "Update release notes", tasks: 3, sessions: 3 },
  ],
  corrections: {
    period: "week",
    periods: [
      { start: "2026-05-04", corrections: 6 },
      { start: "2026-05-11", corrections: 0 },
      { start: "2026-05-18", corrections: 3 },
    ],
  },
};

const filters: FilterOptions = {
  projects: [
    { name: "blog", path: "/code/blog" },
    { name: "shop", path: "/code/shop" },
  ],
  harnesses: ["claude-code", "cursor"],
};

const workflows: WorkflowList = {
  repeatRule: { minMembers: 3, minSessions: 2, windowDays: 60 },
  workflows: [
    {
      id: 4,
      name: "Write database migrations",
      tasks: 7,
      sessions: 5,
      harnesses: ["claude-code", "cursor"],
      projects: [{ name: "shop", path: "/code/shop" }],
      suggestion: { id: 2, state: "Pending" },
      correctionsPerTask: 1.25,
    },
  ],
  nearWorkflows: [
    {
      id: 9,
      name: "Update release notes",
      tasks: 2,
      sessions: 2,
      harnesses: ["claude-code"],
      projects: [],
      suggestion: null,
      correctionsPerTask: null,
      needs: { tasks: 1, sessions: 0 },
    },
  ],
  filters,
};

const workflow: WorkflowDetail = {
  id: 4,
  name: "Write database migrations",
  passesRepeatRule: true,
  tasks: [
    {
      title: "write a migration for orders",
      session: "sess-1",
      position: 0,
      harness: "claude-code",
      project: { name: "shop", path: "/code/shop" },
      at: "2026-05-04T09:00:00.000Z",
      corrections: 2,
    },
  ],
  correctionsPerTask: { overall: 2, byMonth: [{ month: "2026-05", tasks: 1, corrections: 2, correctionsPerTask: 2 }] },
  sessions: 1,
  harnesses: ["claude-code"],
  suggestions: [{ id: 2, state: "Pending", title: "Write a database migration" }],
  filters,
};

const sessionView: SessionView = {
  id: "sess-1",
  harness: "claude-code",
  project: { name: "shop", path: "/code/shop" },
  startedAt: "2026-05-04T09:00:00.000Z",
  endedAt: "2026-05-04T09:10:00.000Z",
  model: "claude-sonnet",
  userMessageCount: 3,
  assistantTurnCount: 2,
  subagentRunCount: 0,
  tokens: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
  tasks: [
    { position: 0, title: "write a migration for orders", workflow: { id: 4, name: "Write database migrations" }, corrections: 1 },
    { position: 1, title: "fix the footer", workflow: null, corrections: 0 },
  ],
  messages: [
    { role: "user", text: "write a migration for orders", timestamp: null, task: 0, intent: "New Task" },
    { role: "tool", name: "Bash", status: "completed", timestamp: null, task: 0 },
    { role: "assistant", text: "Done.", timestamp: null, task: 0 },
    { role: "user", text: "no, use a transaction", timestamp: null, task: 0, intent: "Correction" },
    { role: "user", text: "fix the footer", timestamp: null, task: 1, intent: "New Task" },
  ],
};

const sessions: SessionList = { sessions: [sessionView], filters };

describe("UI screens", () => {
  it("Workflows lists Workflows and near-Workflows with counts, Harnesses, Suggestion state and filters", () => {
    const html = renderToStaticMarkup(<WorkflowsScreen list={workflows} filter={{ harness: "cursor" }} />);

    for (const text of ["Write database migrations", "1.25", "7 Tasks", "5 Sessions", "Cursor", "Pending", "Update release notes", "needs 1 more Task"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('href="/workflows/4?harness=cursor"');
    expect(html).toMatch(/<option value="cursor" selected="">/);
    expect(html).toContain('<option value="/code/shop">shop</option>');
  });

  it("Workflow shows its Tasks, each linking to the Session viewer", () => {
    const html = renderToStaticMarkup(<WorkflowScreen workflow={workflow} filter={{}} />);

    expect(html).toContain("write a migration for orders");
    expect(html).toContain('href="/sessions/sess-1#task-0"');
    expect(html).toContain("Write a database migration");
    expect(html).toContain("2.00 Corrections per Task");
  });

  it("Sessions lists Sessions linking to the viewer, with filters", () => {
    const html = renderToStaticMarkup(<SessionsScreen list={sessions} filter={{}} />);

    expect(html).toContain('href="/sessions/sess-1"');
    expect(html).toContain("shop");
  });

  it("Session viewer shows messages with Task boundaries and Corrections marked", () => {
    const html = renderToStaticMarkup(<SessionScreen session={sessionView} />);

    expect(html.match(/class="task-boundary"/g)).toHaveLength(2);
    expect(html).toContain('id="task-0"');
    expect(html).toMatch(/class="message user correction"[^]*no, use a transaction/);
    expect(html).toContain("Done.");
    expect(html).toContain("Bash");
    expect(html).toContain('href="/workflows/4"');
    expect(html).toContain("1 Correction");
  });

  it("Overview shows the counts, top Workflows and a Corrections-over-time chart", () => {
    const html = renderToStaticMarkup(<OverviewScreen overview={overview} />);

    for (const text of ["12", "31", "Sessions", "Tasks", "Workflows", "Write database migrations", "Update release notes"]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/<svg[^>]*aria-label="Corrections per week"/);
    expect(html.match(/<rect/g)).toHaveLength(3);
    expect(html).toContain("2026-05-04: 6 Corrections");
  });
});
