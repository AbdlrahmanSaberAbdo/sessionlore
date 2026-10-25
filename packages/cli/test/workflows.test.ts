import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubble, FixtureHome, turn, writeClaudeSession, writeCursorDatabase } from "@sessionlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, writeConfig, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

/**
 * A Model Provider that splits every Session into one Task per User Message,
 * titled with the message text, and names each Cluster with `clusterName`.
 */
function oneTaskPerMessage(clusterName: (request: string) => string = () => "Some Cluster") {
  return scriptedModelProvider((request) => {
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) return { name: clusterName(request) };
    return {
      tasks: messages.map(([, index, text]) => ({
        title: text,
        messages: [{ index: Number(index), intent: "New Task" }],
      })),
    };
  });
}

function session(startedAt: string, ...requests: string[]) {
  return writeClaudeSession(home, {
    cwd: home.gitRepo("code/shop"),
    startedAt,
    turns: requests.flatMap((r) => [turn.user(r), turn.assistant("Done.")]),
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");

async function analyze(options: RunOptions) {
  expect((await runCli(home, ["scan"], options)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], options);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

async function workflows(options: RunOptions = {}) {
  const result = await runCli(home, ["workflows", "--json"], options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

describe("workflows", () => {
  it("groups similar Tasks into one Workflow, named by the cheap model, and leaves unrelated Tasks out", async () => {
    const first = session("2026-05-10T09:00:00.000Z", "write a database migration for orders", "update the release notes");
    const second = session("2026-05-20T09:00:00.000Z", "add a database migration for users", "fix the flaky login test");
    const third = session("2026-05-25T09:00:00.000Z", "database migration for the cart table");
    const provider = oneTaskPerMessage((request) => (request.includes("migration") ? "Write database migrations" : "Other"));
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(["database migration"]), clock: now };

    await analyze(options);
    const result = await workflows(options);

    expect(result.workflows).toHaveLength(1);
    const [workflow] = result.workflows;
    expect(workflow.name).toBe("Write database migrations");
    expect(workflow.tasks.map((t: any) => [t.title, t.session])).toEqual([
      ["write a database migration for orders", first.id],
      ["add a database migration for users", second.id],
      ["database migration for the cart table", third.id],
    ]);
    expect(workflow.sessions.map((s: any) => s.id)).toEqual([first.id, second.id, third.id]);
    expect(workflow.tasks[0]).toMatchObject({ harness: "claude-code", project: { name: "shop" }, at: "2026-05-10T09:00:00.000Z" });
    expect(result.nearWorkflows).toEqual([]);
  });

  it("lists 3 similar Tasks all in one Session as a near-Workflow that needs one more Session", async () => {
    const only = session(
      "2026-05-10T09:00:00.000Z",
      "write a database migration for orders",
      "add a database migration for users",
      "database migration for the cart table",
    );
    const provider = oneTaskPerMessage(() => "Write database migrations");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(["database migration"]), clock: now };

    await analyze(options);
    const result = await workflows(options);

    expect(result.workflows).toEqual([]);
    expect(result.nearWorkflows).toHaveLength(1);
    expect(result.nearWorkflows[0]).toMatchObject({
      name: "Write database migrations",
      sessions: [{ id: only.id }],
      counted: { tasks: 3, sessions: 1 },
      needs: { tasks: 0, sessions: 1 },
    });
  });

  it("says how many more Tasks a near-Workflow needs", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session("2026-05-20T09:00:00.000Z", "add a database migration for users");
    const provider = oneTaskPerMessage(() => "Write database migrations");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(["database migration"]), clock: now };

    await analyze(options);
    const result = await workflows(options);

    expect(result.workflows).toEqual([]);
    expect(result.nearWorkflows.map((w: any) => w.needs)).toEqual([{ tasks: 1, sessions: 0 }]);
  });

  it("drops a Workflow once the Clock moves its Tasks outside the Repeat Rule's window", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session("2026-05-20T09:00:00.000Z", "add a database migration for users", "database migration for the cart table");
    const provider = oneTaskPerMessage(() => "Write database migrations");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(["database migration"]), clock: now };
    await analyze(options);
    expect((await workflows(options)).workflows).toHaveLength(1);

    // 60 days after 2026-05-10 the first Session's Task leaves the window; 2026-07-25 leaves none inside it.
    const later = await workflows({ clock: fixedClock("2026-07-15T12:00:00.000Z") });
    expect(later.workflows).toEqual([]);
    expect(later.nearWorkflows.map((w: any) => [w.counted, w.needs])).toEqual([
      [
        { tasks: 2, sessions: 1 },
        { tasks: 1, sessions: 1 },
      ],
    ]);
    const muchLater = await workflows({ clock: fixedClock("2026-07-25T12:00:00.000Z") });
    expect(muchLater).toMatchObject({ workflows: [], nearWorkflows: [] });
  });

  it("uses the Repeat Rule from the config file", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session("2026-05-20T09:00:00.000Z", "add a database migration for users");
    session("2026-05-22T09:00:00.000Z", "update the release notes", "release notes for 2.0");
    const provider = oneTaskPerMessage((request) => (request.includes("migration") ? "Write database migrations" : "Write release notes"));
    const options = {
      modelProvider: provider.modelProvider,
      embedder: topicEmbedder(["database migration", "release notes"]),
      clock: now,
    };
    await analyze(options);
    expect((await workflows(options)).workflows).toEqual([]);

    writeConfig(home, { repeatRule: { minMembers: 2 } });
    const twoTasks = await workflows(options);
    expect(twoTasks.repeatRule).toEqual({ minMembers: 2, minSessions: 2, windowDays: 60 });
    expect(twoTasks.workflows.map((w: any) => w.name)).toEqual(["Write database migrations"]);

    writeConfig(home, { repeatRule: { minMembers: 2, minSessions: 1, windowDays: 12 } });
    const recentOnly = await workflows(options);
    expect(recentOnly.workflows.map((w: any) => w.name)).toEqual(["Write release notes"]);
  });

  it("rejects an invalid Repeat Rule in the config file", async () => {
    writeConfig(home, { repeatRule: { minMembers: 0, windowDays: "soon" } });

    const result = await runCli(home, ["workflows", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("repeatRule.minMembers");
  });

  it("groups Tasks from Claude Code and Cursor Sessions into one Workflow", async () => {
    const repo = home.gitRepo("code/shop");
    const claude = session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    const {
      composerIds: [cursor],
    } = writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-20T09:00:00.000Z",
        bubbles: [
          bubble.user("add a database migration for users"),
          bubble.assistant("Done."),
          bubble.user("database migration for the cart table"),
          bubble.assistant("Done."),
        ],
      },
    ]);
    const provider = oneTaskPerMessage(() => "Write database migrations");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(["database migration"]), clock: now };

    await analyze(options);
    const [workflow] = (await workflows(options)).workflows;

    expect(workflow.harnesses).toEqual(["claude-code", "cursor"]);
    expect(workflow.sessions).toEqual([
      { id: claude.id, harness: "claude-code", project: { name: "shop", path: repo } },
      { id: cursor, harness: "cursor", project: { name: "shop", path: repo } },
    ]);
  });
});
