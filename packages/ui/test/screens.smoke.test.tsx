import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FilterOptions, ReviewQueue, SessionView, SuggestionReview, WorkflowDetail, WorkflowList } from "@sessionlore/core";
import { Rail, TopBar } from "../src/components/rail.js";
import { CorrectionsScreen } from "../src/screens/corrections.js";
import { PendingScreen, ReviewScreen, type ReviewActions } from "../src/screens/review.js";
import { SessionScreen } from "../src/screens/sessions.js";
import { WorkflowScreen, WorkflowsScreen } from "../src/screens/workflows.js";

/**
 * The UI's smoke test: each screen renders the data the API returns. UI logic
 * is kept thin; behaviour is tested through the API (Seam 2).
 */

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

  it("The rail shows Home with the Pending count, Workflows with how many, and Corrections, marking the current section", () => {
    const html = renderToStaticMarkup(<Rail section="/workflows" pending={3} counts={{ sessions: 12, tasks: 31, workflows: 2 }} />);

    expect(html).toMatch(/<a href="\/" class="nav"><svg[^]*?<\/svg>Home<span class="count pending">3<span class="visually-hidden"> Pending<\/span><\/span><\/a>/);
    expect(html).toMatch(/<a href="\/workflows" class="nav" aria-current="page"><svg[^]*?<\/svg>Workflows<span class="count">2<\/span><\/a>/);
    expect(html).toMatch(/<a href="\/corrections" class="nav"><svg[^]*?<\/svg>Corrections<\/a>/);
  });

  it("The rail leaves out the Pending count when nothing is Pending, and Workflows' count until it is loaded", () => {
    const html = renderToStaticMarkup(<Rail section="/" pending={0} counts={null} />);

    expect(html).toMatch(/<a href="\/" class="nav" aria-current="page"><svg[^]*?<\/svg>Home<\/a>/);
    expect(html).not.toContain('class="count');
  });

  it("The top bar shows the wordmark and how much was read, once it is loaded", () => {
    const loaded = renderToStaticMarkup(<TopBar counts={{ sessions: 12, tasks: 31, workflows: 2 }} />);
    const loading = renderToStaticMarkup(<TopBar counts={null} />);

    expect(loaded).toMatch(/<a href="\/" class="wordmark">[^]*sessionlore<\/a>/);
    expect(loaded).toContain("Read from 12 Sessions and 31 Tasks");
    expect(loading).not.toContain("Read from");
  });

  it("Home lists Pending Suggestions, Skills then Rules, with Evidence count and Scope, linking to each", () => {
    const html = renderToStaticMarkup(<PendingScreen queue={queue} />);

    expect(html).toContain("2 to review");
    expect(html).toMatch(/<h2><span class="mark"[^>]*><\/span>Skills<\/h2>[^]*Write a database migration[^]*<h2><span class="mark rule"[^>]*><\/span>Rules<\/h2>[^]*Use pnpm/);
    for (const text of ["Seen in 3 Tasks, for Project scope (shop).", "From 4 Corrections, for User scope.", "Updates /code/shop/CLAUDE.md"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('<li class="rule">');
    expect(html).toContain('href="/suggestions/2"');
  });

  it("Home says how to get Suggestions when none is Pending", () => {
    const html = renderToStaticMarkup(<PendingScreen queue={{ suggestions: [] }} />);

    expect(html).toContain("Nothing to review");
    expect(html).toContain("<code>sessionlore suggest</code>");
    expect(html).not.toContain("<h2>Skills</h2>");
  });

  it("Corrections says where to see Correction Clusters for now", () => {
    const html = renderToStaticMarkup(<CorrectionsScreen />);

    expect(html).toContain("<code>sessionlore corrections</code>");
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
});
