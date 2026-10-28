import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  FilterOptions,
  MindMap,
  Overview,
  ReviewQueue,
  SessionList,
  SessionView,
  SuggestionReview,
  WorkflowDetail,
  WorkflowList,
} from "@habitlore/core";
import { MindMapScreen } from "../src/screens/mind-map.js";
import { OverviewScreen } from "../src/screens/overview.js";
import { ReviewQueueScreen, ReviewScreen, type ReviewActions } from "../src/screens/review.js";
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

const queue: ReviewQueue = {
  suggestions: [
    {
      id: 2,
      kind: "skill",
      title: "Write a database migration",
      scope: { kind: "project", project: { name: "shop", path: "/code/shop" } },
      evidence: 3,
      target: null,
      createdAt: "2026-06-01T12:00:00.000Z",
    },
    {
      id: 3,
      kind: "rule",
      title: "Use pnpm",
      scope: { kind: "user" },
      evidence: 4,
      target: { kind: "rule", path: "/code/shop/CLAUDE.md", line: "- Always run things with pnpm." },
      createdAt: "2026-06-01T12:00:00.000Z",
    },
  ],
};

const evidence = {
  task: { title: "write a migration for orders", at: "2026-05-04T09:00:00.000Z" },
  session: { id: "sess-1", harness: "claude-code" as const },
  project: { name: "shop", path: "/code/shop" },
};

const skillReview: SuggestionReview = {
  suggestion: {
    id: 2,
    kind: "skill",
    state: "Pending",
    title: "Write a database migration",
    trigger: "Use when changing a table.",
    steps: ["Write it.", "Run it."],
    workflow: { id: 4, name: "Write database migrations" },
    companionOf: null,
    evidence: [evidence],
    scope: { kind: "project", project: { name: "shop", path: "/code/shop" } },
    createdAt: "2026-06-01T12:00:00.000Z",
    acceptedAt: null,
    rejectedAt: null,
    installedFiles: [],
    target: null,
  },
  form: { title: "Write a database migration", trigger: "Use when changing a table.", steps: ["Write it.", "Run it."] },
  changes: [{ path: "/code/shop/.claude/skills/write-a-database-migration/SKILL.md", before: null, after: "# Write a database migration\n", diff: "" }],
  changesError: null,
  evidence: [{ ...evidence, taskPosition: 0 }],
  projects: filters.projects,
};

const ruleReview: SuggestionReview = {
  ...skillReview,
  suggestion: {
    ...skillReview.suggestion,
    kind: "rule",
    id: 3,
    title: "Use pnpm",
    rule: "Use pnpm.",
    correctionCluster: null,
    target: { kind: "rule", path: "/code/shop/CLAUDE.md", line: "- Always run things with pnpm." },
  } as SuggestionReview["suggestion"],
  form: { title: "Use pnpm", rule: "Use pnpm." },
  changes: [
    {
      path: "/code/shop/CLAUDE.md",
      before: "- Always run things with pnpm.\n",
      after: "- Use pnpm.\n",
      diff: "--- /code/shop/CLAUDE.md\n+++ /code/shop/CLAUDE.md\n@@ -1 +1 @@\n-- Always run things with pnpm.\n+- Use pnpm.\n",
    },
  ],
  evidence: [{ ...evidence, correction: { text: "no, use pnpm", at: "2026-05-04T09:05:00.000Z" }, taskPosition: 0 }],
};

const noActions: ReviewActions = { save: async () => {}, setScope: async () => {}, accept: async () => {}, reject: async () => {} };


const mindMap: MindMap = {
  nodes: [
    { id: "project:/code/shop", kind: "project", label: "shop", path: "/code/shop", harnesses: ["claude-code", "cursor"] },
    {
      id: "workflow:4",
      kind: "workflow",
      label: "Write database migrations",
      harnesses: ["claude-code", "cursor"],
      workflow: 4,
      tasks: 2,
      sessions: 2,
      correctionsPerTask: 0.5,
    },
    {
      id: "task:claude-code:sess-1:0",
      kind: "task",
      label: "write a migration for orders",
      harnesses: ["claude-code"],
      session: "sess-1",
      position: 0,
      at: "2026-05-04T09:00:00.000Z",
      corrections: 1,
    },
    {
      id: "task:cursor:sess-2:0",
      kind: "task",
      label: "migration for the cart table",
      harnesses: ["cursor"],
      session: "sess-2",
      position: 0,
      at: "2026-05-26T09:00:00.000Z",
      corrections: 0,
    },
    {
      id: "session:claude-code:sess-1",
      kind: "session",
      label: "shop · 2026-05-04",
      harnesses: ["claude-code"],
      session: "sess-1",
      project: { name: "shop", path: "/code/shop" },
      startedAt: "2026-05-04T09:00:00.000Z",
    },
    {
      id: "session:cursor:sess-2",
      kind: "session",
      label: "shop · 2026-05-26",
      harnesses: ["cursor"],
      session: "sess-2",
      project: { name: "shop", path: "/code/shop" },
      startedAt: "2026-05-26T09:00:00.000Z",
    },
    { id: "suggestion:2", kind: "suggestion", label: "Write a database migration", harnesses: ["claude-code", "cursor"], suggestion: 2, state: "Pending" },
  ],
  edges: [
    { id: "e1", source: "project:/code/shop", target: "workflow:4" },
    { id: "e2", source: "workflow:4", target: "task:claude-code:sess-1:0" },
    { id: "e3", source: "workflow:4", target: "task:cursor:sess-2:0" },
    { id: "e4", source: "task:claude-code:sess-1:0", target: "session:claude-code:sess-1" },
    { id: "e5", source: "task:cursor:sess-2:0", target: "session:cursor:sess-2" },
    { id: "e6", source: "workflow:4", target: "suggestion:2" },
  ],
  filters,
};

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

  it("Review lists Pending Suggestions with kind, Scope and Evidence count, linking to each", () => {
    const html = renderToStaticMarkup(<ReviewQueueScreen queue={queue} />);

    for (const text of ["Write a database migration", "Skill", "Project scope (shop)", "3 Tasks", "Rule", "User scope", "4 Corrections", "Updates /code/shop/CLAUDE.md"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('href="/suggestions/2"');
  });

  it("A Suggestion in review shows what accepting writes, an edit form, the Scope, actions and Evidence links", () => {
    const html = renderToStaticMarkup(<ReviewScreen review={skillReview} actions={noActions} notice="Saved your changes." />);

    expect(html).toContain("/code/shop/.claude/skills/write-a-database-migration/SKILL.md");
    expect(html).toContain("# Write a database migration");
    expect(html).toMatch(/<textarea[^>]*>Write it.\nRun it.<\/textarea>/);
    expect(html).toMatch(/<option value="\/code\/shop" selected="">Project scope: shop<\/option>/);
    expect(html).toContain(">Accept</button>");
    expect(html).toContain(">Reject</button>");
    expect(html).toContain('href="/sessions/sess-1#task-0"');
    expect(html).toContain("Saved your changes.");
  });

  it("A Suggestion with a Target shows the diff, and a Rule's Evidence shows its Corrections", () => {
    const html = renderToStaticMarkup(<ReviewScreen review={ruleReview} actions={noActions} />);

    expect(html).toContain('<span class="del">-- Always run things with pnpm.');
    expect(html).toContain('<span class="add">+- Use pnpm.');
    expect(html).toContain("updates /code/shop/CLAUDE.md");
    expect(html).toContain("“no, use pnpm”");
  });

  it("A Suggestion no longer Pending has no actions or edit form", () => {
    const accepted: SuggestionReview = {
      ...skillReview,
      suggestion: { ...skillReview.suggestion, state: "Accepted", installedFiles: ["/code/shop/x/SKILL.md"] },
      form: null,
      changes: null,
    };

    const html = renderToStaticMarkup(<ReviewScreen review={accepted} actions={noActions} />);

    expect(html).toContain("Accepted");
    expect(html).toContain("/code/shop/x/SKILL.md");
    expect(html).not.toContain(">Accept</button>");
    expect(html).not.toContain("<textarea");
  });

  it("Mind map draws the graph coloured by Harness, with filters and a legend", () => {
    const html = renderToStaticMarkup(<MindMapScreen map={mindMap} filter={{}} />);

    for (const text of ["shop", "Write database migrations", "write a migration for orders", "shop · 2026-05-26", "Write a database migration"]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/class="mind-node task harness-claude-code"/);
    expect(html).toMatch(/class="mind-node session harness-cursor"/);
    expect(html).toContain('<option value="cursor">Cursor</option>');
    expect(html).toMatch(/class="legend"[^]*Claude Code[^]*Cursor/);
  });

  it("Mind map shows a clicked node's details, linking Workflows and Sessions to their screens", () => {
    const workflowHtml = renderToStaticMarkup(<MindMapScreen map={mindMap} filter={{ harness: "cursor" }} initialSelected="workflow:4" />);
    const sessionHtml = renderToStaticMarkup(<MindMapScreen map={mindMap} filter={{}} initialSelected="session:cursor:sess-2" />);

    expect(workflowHtml).toMatch(/class="mind-details[^"]*"[^]*2 Tasks[^]*0.50 Corrections per Task/);
    expect(workflowHtml).toContain('href="/workflows/4?harness=cursor"');
    expect(sessionHtml).toContain('href="/sessions/sess-2"');
  });

  it("Mind map links a Suggestion node to its review screen", () => {
    const html = renderToStaticMarkup(<MindMapScreen map={mindMap} filter={{}} initialSelected="suggestion:2" />);

    expect(html).toContain('href="/suggestions/2"');
  });

  it("Mind map hides a collapsed node's Tasks and Sessions", () => {
    const html = renderToStaticMarkup(<MindMapScreen map={mindMap} filter={{}} initialCollapsed={["workflow:4"]} />);

    expect(html).toContain("Write database migrations");
    expect(html).not.toContain("write a migration for orders");
    expect(html).not.toContain("shop · 2026-05-04");
    expect(html).toContain("2 hidden");
  });
});
