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
 * A Model Provider that starts a Task for every User Message. Clusters are
 * named after their topic, and any Workflow asked about gets a Skill.
 */
const provider = scriptedModelProvider((request) => {
  if (request.includes("<workflow")) {
    return { title: "Write a database migration", trigger: "Use when changing a table.", steps: ["Write it.", "Run it."] };
  }
  const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
  if (messages.length === 0) {
    return { name: request.includes("migration") ? "Write database migrations" : "Write release notes" };
  }
  return { tasks: messages.map(([, index, text]) => ({ title: text!, messages: [{ index: Number(index), intent: "New Task" }] })) };
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

async function get(path: string) {
  api ??= openApi(home, options);
  const response = await api.get(path);
  expect(response.status, response.text).toBe(200);
  return response.json();
}

/** A migrations Workflow over two Projects and two Harnesses, with a Skill Suggestion; release notes stay a near-Workflow. */
async function migrationsWorkflow() {
  const shop = session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders", "update the release notes");
  const blog = session("code/blog", "2026-05-20T09:00:00.000Z", "add a database migration for users");
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
  await cli("scan");
  expect((await cli("analyze", "--json", "--yes")).json().failed).toEqual([]);
  const [suggestion] = (await cli("suggest", "--json")).json().created;
  return { shop: shop.id, blog: blog.id, cursor: cursor.composerIds[0]!, suggestion: suggestion as number };
}

/** Each edge as "kind label -> kind label", sorted, so a test reads like the hierarchy. */
function edgeLines(map: any): string[] {
  const byId = new Map(map.nodes.map((n: any) => [n.id, n]));
  const name = (id: string) => {
    const node: any = byId.get(id);
    expect(node, `edge end ${id}`).toBeDefined();
    return `${node.kind} ${node.label}`;
  };
  return map.edges.map((e: any) => `${name(e.source)} -> ${name(e.target)}`).sort();
}

const nodesOf = (map: any, kind: string) => map.nodes.filter((n: any) => n.kind === kind);

describe("mind map API", () => {
  it("returns Projects, Workflows, Tasks, Sessions and Suggestions as nodes, linked in that hierarchy", async () => {
    const ids = await migrationsWorkflow();

    const map = await get("/api/mind-map");

    expect(edgeLines(map)).toEqual(
      [
        "project blog -> workflow Write database migrations",
        "project shop -> workflow Write database migrations",
        "workflow Write database migrations -> suggestion Write a database migration",
        "workflow Write database migrations -> task write a database migration for orders",
        "workflow Write database migrations -> task add a database migration for users",
        "workflow Write database migrations -> task database migration for the cart table",
        "task write a database migration for orders -> session shop · 2026-05-04",
        "task add a database migration for users -> session blog · 2026-05-20",
        "task database migration for the cart table -> session shop · 2026-05-26",
      ].sort(),
    );
    expect(nodesOf(map, "workflow")).toEqual([
      expect.objectContaining({
        label: "Write database migrations",
        workflow: expect.any(Number),
        harnesses: ["claude-code", "cursor"],
        tasks: 3,
        sessions: 3,
      }),
    ]);
    expect(nodesOf(map, "session").map((n: any) => [n.session, n.harnesses])).toEqual([
      [ids.shop, ["claude-code"]],
      [ids.blog, ["claude-code"]],
      [ids.cursor, ["cursor"]],
    ]);
    expect(nodesOf(map, "task").map((n: any) => [n.label, n.session, n.position])).toEqual([
      ["write a database migration for orders", ids.shop, 0],
      ["add a database migration for users", ids.blog, 0],
      ["database migration for the cart table", ids.cursor, 0],
    ]);
    expect(nodesOf(map, "suggestion")).toEqual([
      expect.objectContaining({ suggestion: ids.suggestion, state: "Pending", harnesses: ["claude-code", "cursor"] }),
    ]);
    expect(nodesOf(map, "project").map((n: any) => [n.label, n.path, n.harnesses])).toEqual([
      ["shop", home.gitRepo("code/shop"), ["claude-code", "cursor"]],
      ["blog", home.gitRepo("code/blog"), ["claude-code"]],
    ]);
    expect(map.filters.harnesses).toEqual(["claude-code", "cursor"]);
  });

  it("hides the other Harness's Tasks, Sessions and Projects when filtered by Harness", async () => {
    const ids = await migrationsWorkflow();

    const map = await get("/api/mind-map?harness=cursor");

    expect(edgeLines(map)).toEqual([
      "project shop -> workflow Write database migrations",
      "task database migration for the cart table -> session shop · 2026-05-26",
      "workflow Write database migrations -> suggestion Write a database migration",
      "workflow Write database migrations -> task database migration for the cart table",
    ]);
    expect(map.nodes.every((n: any) => n.harnesses.join() === "cursor")).toBe(true);
    expect(nodesOf(map, "session").map((n: any) => n.session)).toEqual([ids.cursor]);
    // The filter offers every Harness, so the other one can be picked again.
    expect(map.filters.harnesses).toEqual(["claude-code", "cursor"]);
  });

  it("narrows by Project and date range, and leaves out a Workflow with no Task left", async () => {
    await migrationsWorkflow();

    const byProject = await get(`/api/mind-map?project=${encodeURIComponent(home.gitRepo("code/blog"))}`);
    const byDate = await get("/api/mind-map?from=2026-05-27");

    expect(nodesOf(byProject, "project").map((n: any) => n.label)).toEqual(["blog"]);
    expect(nodesOf(byProject, "task").map((n: any) => n.label)).toEqual(["add a database migration for users"]);
    expect(byDate.nodes).toEqual([]);
    expect(byDate.edges).toEqual([]);
  });

  it("never shows excluded Projects or their Sessions", async () => {
    // A fourth migration keeps the Workflow passing the Repeat Rule without blog.
    session("code/docs", "2026-05-28T09:00:00.000Z", "a database migration for pages");
    await migrationsWorkflow();
    writeConfig(home, { projects: { exclude: ["blog"] } });

    const map = await get("/api/mind-map");

    expect(nodesOf(map, "project").map((n: any) => n.label).sort()).toEqual(["docs", "shop"]);
    expect(nodesOf(map, "task")).toHaveLength(3);
    expect(JSON.stringify(map)).not.toContain("blog");
  });
});
