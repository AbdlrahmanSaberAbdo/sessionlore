import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubble, FixtureHome, turn, writeClaudeSession, writeCursorDatabase } from "@sessionlore/fixtures";
import { openApi, type Api } from "./support/api.js";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, writeConfig, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;
let api: Api | undefined;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  api?.close();
  api = undefined;
  home.remove();
});

/**
 * A Model Provider that starts a Task for every User Message, except that a
 * message starting with "no," is a Correction in the Task before it. Clusters
 * are named after their topic, and any Workflow asked about gets a Skill.
 */
const provider = scriptedModelProvider((request) => {
  if (request.includes("<workflow")) {
    return { title: "Write a database migration", trigger: "Use when changing a table.", steps: ["Write it.", "Run it."] };
  }
  const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
  if (messages.length === 0) {
    return { name: request.includes("migration") ? "Write database migrations" : "Write release notes" };
  }
  const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
  for (const [, index, text] of messages) {
    if (text!.startsWith("no,") && tasks.length > 0) tasks.at(-1)!.messages.push({ index: Number(index), intent: "Correction" });
    else tasks.push({ title: text!, messages: [{ index: Number(index), intent: "New Task" }] });
  }
  return { tasks };
});

const options: RunOptions = {
  modelProvider: provider.modelProvider,
  embedder: topicEmbedder(["database migration", "release notes"]),
  clock: fixedClock("2026-06-01T12:00:00.000Z"),
};

function session(repo: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd: home.gitRepo(repo),
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant(`Done: ${m}`)]),
  });
}

async function cli(...args: string[]) {
  const result = await runCli(home, args, options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

async function scanAndAnalyze() {
  await cli("scan");
  expect((await cli("analyze", "--json", "--yes")).json().failed).toEqual([]);
}

async function get(path: string) {
  api ??= openApi(home, options);
  const response = await api.get(path);
  expect(response.status, response.text).toBe(200);
  return response.json();
}

/** Three migration Tasks in two Projects and two Harnesses, plus two release-notes Tasks (a near-Workflow). */
function migrationsAndReleaseNotes() {
  const shop = session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders", "update the release notes");
  const blog = session("code/blog", "2026-05-20T09:00:00.000Z", "add a database migration for users", "no, use a transaction");
  const cursor = writeCursorDatabase(home, [
    {
      folder: home.gitRepo("code/shop"),
      createdAt: "2026-05-26T09:00:00.000Z",
      bubbles: [
        bubble.user("database migration for the cart table"),
        bubble.assistant("Done."),
        bubble.user("write the release notes for 2.0"),
        bubble.assistant("Done."),
      ],
    },
  ]);
  return { shop: shop.id, blog: blog.id, cursor: cursor.composerIds[0]! };
}

describe("workflows API", () => {
  it("lists Workflows and near-Workflows with Task count, Session count, Harnesses and Suggestion state", async () => {
    migrationsAndReleaseNotes();
    await scanAndAnalyze();

    const result = await get("/api/workflows");

    expect(result.workflows).toEqual([
      {
        id: expect.any(Number),
        name: "Write database migrations",
        tasks: 3,
        sessions: 3,
        harnesses: ["claude-code", "cursor"],
        projects: [
          { name: "shop", path: home.gitRepo("code/shop") },
          { name: "blog", path: home.gitRepo("code/blog") },
        ],
        suggestion: null,
        // One Correction across the three Tasks.
        correctionsPerTask: 0.33,
      },
    ]);
    expect(result.nearWorkflows).toEqual([
      expect.objectContaining({ name: "Write release notes", tasks: 2, sessions: 2, needs: { tasks: 1, sessions: 0 } }),
    ]);
  });

  it("shows each Workflow's Suggestion and its state", async () => {
    migrationsAndReleaseNotes();
    await scanAndAnalyze();
    const [created] = (await cli("suggest", "--json")).json().created;
    await cli("reject", String(created));

    const [workflow] = (await get("/api/workflows")).workflows;

    expect(workflow.suggestion).toEqual({ id: created, state: "Rejected" });
  });

  it("narrows Workflows by Project, Harness and date range, and offers the values to filter by", async () => {
    migrationsAndReleaseNotes();
    await scanAndAnalyze();
    const shop = home.gitRepo("code/shop");

    const all = await get("/api/workflows");
    const byProject = await get(`/api/workflows?project=${encodeURIComponent(shop)}`);
    const byHarness = await get("/api/workflows?harness=cursor");
    const byDate = await get("/api/workflows?from=2026-05-10&to=2026-05-25");

    expect(all.filters).toEqual({
      projects: [
        { name: "blog", path: home.gitRepo("code/blog") },
        { name: "shop", path: shop },
      ],
      harnesses: ["claude-code", "cursor"],
    });
    expect(byProject.workflows).toEqual([expect.objectContaining({ tasks: 2, sessions: 2, harnesses: ["claude-code", "cursor"] })]);
    expect(byProject.nearWorkflows).toEqual([expect.objectContaining({ name: "Write release notes", tasks: 2 })]);
    expect(byHarness.workflows).toEqual([expect.objectContaining({ tasks: 1, harnesses: ["cursor"] })]);
    expect(byDate.workflows).toEqual([expect.objectContaining({ tasks: 1, projects: [{ name: "blog", path: home.gitRepo("code/blog") }] })]);
    // A near-Workflow with no Task in the range is left out.
    expect(byDate.nearWorkflows).toEqual([]);
  });

  it("never shows excluded Projects", async () => {
    migrationsAndReleaseNotes();
    await scanAndAnalyze();
    writeConfig(home, { projects: { exclude: ["blog"] } });

    const result = await get("/api/workflows");

    expect(result.filters.projects.map((p: any) => p.name)).toEqual(["shop"]);
    expect(JSON.stringify(result)).not.toContain("blog");
  });
});

describe("workflow API", () => {
  it("shows one Workflow's Tasks, each with the Session it is in, and its Suggestions", async () => {
    const ids = migrationsAndReleaseNotes();
    await scanAndAnalyze();
    const [created] = (await cli("suggest", "--json")).json().created;
    const [{ id }] = (await get("/api/workflows")).workflows;

    const workflow = await get(`/api/workflows/${id}`);

    expect(workflow).toMatchObject({ id, name: "Write database migrations", passesRepeatRule: true, sessions: 3 });
    expect(workflow.tasks.map((t: any) => [t.title, t.session, t.harness, t.position])).toEqual([
      ["write a database migration for orders", ids.shop, "claude-code", 0],
      ["add a database migration for users", ids.blog, "claude-code", 0],
      ["database migration for the cart table", ids.cursor, "cursor", 0],
    ]);
    expect(workflow.suggestions).toEqual([{ id: created, state: "Pending", title: "Write a database migration" }]);
  });

  it("narrows the Tasks by the same filters", async () => {
    migrationsAndReleaseNotes();
    await scanAndAnalyze();
    const [{ id }] = (await get("/api/workflows")).workflows;

    const workflow = await get(`/api/workflows/${id}?harness=cursor`);

    expect(workflow.tasks.map((t: any) => t.title)).toEqual(["database migration for the cart table"]);
    expect(workflow.sessions).toBe(1);
    expect(workflow.correctionsPerTask).toEqual({
      overall: 0,
      byMonth: [{ month: "2026-05", tasks: 1, corrections: 0, correctionsPerTask: 0 }],
    });
  });

  it("answers 404 for a Workflow that does not exist", async () => {
    api = openApi(home, options);

    const response = await api.get("/api/workflows/999");

    expect(response.status).toBe(404);
    expect(response.json().error).toContain("999");
  });
});

describe("session API", () => {
  it("shows a Session's User Messages and agent replies, each in its Task, with Corrections marked", async () => {
    session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders", "update the release notes");
    const blog = session("code/blog", "2026-05-20T09:00:00.000Z", "add a database migration for users", "no, use a transaction", "fix the footer");
    session("code/blog", "2026-05-26T09:00:00.000Z", "database migration for the cart table");
    await scanAndAnalyze();
    const [workflow] = (await get("/api/workflows")).workflows;

    const viewed = await get(`/api/sessions/${blog.id}`);

    expect(viewed).toMatchObject({ id: blog.id, harness: "claude-code", project: { name: "blog" } });
    expect(viewed.tasks).toEqual([
      { position: 0, title: "add a database migration for users", workflow: { id: workflow.id, name: workflow.name }, corrections: 1 },
      { position: 1, title: "fix the footer", workflow: null, corrections: 0 },
    ]);
    expect(viewed.messages.map((m: any) => [m.role, m.text, m.task, m.intent])).toEqual([
      ["user", "add a database migration for users", 0, "New Task"],
      ["assistant", "Done: add a database migration for users", 0, undefined],
      ["user", "no, use a transaction", 0, "Correction"],
      ["assistant", "Done: no, use a transaction", 0, undefined],
      ["user", "fix the footer", 1, "New Task"],
      ["assistant", "Done: fix the footer", 1, undefined],
    ]);
  });

  it("shows a Session that is not analyzed yet without Tasks", async () => {
    const shop = session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders");
    await cli("scan");

    const viewed = await get(`/api/sessions/${shop.id}`);

    expect(viewed.tasks).toEqual([]);
    expect(viewed.messages.map((m: any) => [m.role, m.task])).toEqual([
      ["user", null],
      ["assistant", null],
    ]);
  });

  it("answers 404 for an unknown Session or one in an excluded Project", async () => {
    const blog = session("code/blog", "2026-05-20T09:00:00.000Z", "add a database migration for users");
    await cli("scan");
    writeConfig(home, { projects: { exclude: ["blog"] } });
    api = openApi(home, options);

    expect((await api.get(`/api/sessions/${blog.id}`)).status).toBe(404);
    expect((await api.get("/api/sessions/nope")).status).toBe(404);
  });
});

describe("sessions API", () => {
  it("lists Sessions latest first, narrowed by Project, Harness and date range, never from excluded Projects", async () => {
    const ids = migrationsAndReleaseNotes();
    await cli("scan");
    const shop = home.gitRepo("code/shop");

    const all = await get("/api/sessions");
    const byProject = await get(`/api/sessions?project=${encodeURIComponent(shop)}`);
    const byHarness = await get("/api/sessions?harness=claude-code");
    const byDate = await get("/api/sessions?from=2026-05-20&to=2026-05-20");
    writeConfig(home, { projects: { exclude: ["blog"] } });
    api?.close();
    api = undefined;
    const excluding = await get("/api/sessions");

    const sessionIds = (result: any) => result.sessions.map((s: any) => s.id);
    expect(sessionIds(all)).toEqual([ids.cursor, ids.blog, ids.shop]);
    expect(all.filters.harnesses).toEqual(["claude-code", "cursor"]);
    expect(sessionIds(byProject)).toEqual([ids.cursor, ids.shop]);
    expect(sessionIds(byHarness)).toEqual([ids.blog, ids.shop]);
    expect(sessionIds(byDate)).toEqual([ids.blog]);
    expect(sessionIds(excluding)).toEqual([ids.cursor, ids.shop]);
  });
});
