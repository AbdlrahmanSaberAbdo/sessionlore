import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, type RunOptions } from "./support/harness.js";
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
function oneTaskPerMessage(clusterName: (request: string) => string) {
  return scriptedModelProvider((request) => oneTaskPerMessageReply(request, clusterName));
}

function oneTaskPerMessageReply(request: string, clusterName: (request: string) => string) {
  const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
  if (messages.length === 0) return { name: clusterName(request) };
  return {
    tasks: messages.map(([, index, text]) => ({
      title: text,
      messages: [{ index: Number(index), intent: "New Task" }],
    })),
  };
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

describe("Lasting Workflows", () => {
  it("keeps a Workflow's identity and name across Analyses while it gains new similar Tasks", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session("2026-05-20T09:00:00.000Z", "add a database migration for users", "database migration for the cart table");
    const embedder = topicEmbedder(["database migration"]);
    const first = { modelProvider: oneTaskPerMessage(() => "Write database migrations").modelProvider, embedder, clock: now };
    await analyze(first);
    const [before] = (await workflows(first)).workflows;

    session("2026-05-28T09:00:00.000Z", "database migration for invoices");
    const second = { modelProvider: oneTaskPerMessage(() => "A different name").modelProvider, embedder, clock: now };
    await analyze(second);
    const after = await workflows(second);

    expect(after.workflows).toHaveLength(1);
    expect(after.workflows[0]).toMatchObject({ id: before.id, name: "Write database migrations" });
    expect(after.workflows[0].tasks.map((t: any) => t.title)).toEqual([
      "write a database migration for orders",
      "add a database migration for users",
      "database migration for the cart table",
      "database migration for invoices",
    ]);
  });

  it("does not put a new Task unlike any Workflow into one", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders");
    session("2026-05-20T09:00:00.000Z", "add a database migration for users", "database migration for the cart table");
    const options = {
      modelProvider: oneTaskPerMessage(() => "Write database migrations").modelProvider,
      embedder: topicEmbedder(["database migration"]),
      clock: now,
    };
    await analyze(options);

    session("2026-05-28T09:00:00.000Z", "update the release notes");
    await analyze(options);
    const [workflow] = (await workflows(options)).workflows;

    expect(workflow.tasks.map((t: any) => t.title)).not.toContain("update the release notes");
    expect(workflow.tasks).toHaveLength(3);
  });
});

/** Two sets of migration Tasks that one Embedder tells apart and another groups together. */
function migrationSessions() {
  session("2026-05-10T09:00:00.000Z", "write a database migration for orders", "schema migration for orders");
  session("2026-05-20T09:00:00.000Z", "add a database migration for users", "schema migration for users");
  session("2026-05-25T09:00:00.000Z", "database migration for the cart table", "schema migration for the cart");
}

const namedByTopic = (request: string) =>
  request.includes("database migration") ? "Write database migrations" : "Write schema migrations";
const apart = () => topicEmbedder(["database migration", "schema migration"], "embedder-apart");
const together = () => topicEmbedder(["migration"], "embedder-together");

async function recluster(options: RunOptions) {
  const result = await runCli(home, ["recluster", "--json"], options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

describe("recluster", () => {
  it("rebuilds the grouping from scratch and reports which old Workflows mapped to which new ones", async () => {
    migrationSessions();
    const modelProvider = oneTaskPerMessage(namedByTopic).modelProvider;
    await analyze({ modelProvider, embedder: apart(), clock: now });
    const before = (await workflows()).workflows;
    const database = before.find((w: any) => w.name === "Write database migrations");
    const schema = before.find((w: any) => w.name === "Write schema migrations");

    const report = await recluster({ modelProvider, embedder: together(), clock: now });

    expect(report.mapped).toEqual([
      { from: { id: database.id, name: "Write database migrations" }, to: { id: database.id, name: "Write database migrations" } },
      { from: { id: schema.id, name: "Write schema migrations" }, to: { id: database.id, name: "Write database migrations" } },
    ]);
    expect(report.created).toEqual([]);
    const after = (await workflows()).workflows;
    expect(after.map((w: any) => [w.id, w.name, w.tasks.length])).toEqual([[database.id, "Write database migrations", 6]]);
  });

  it("keeps the old Workflow's identity for the larger part of a split, and names the other part as a new Workflow", async () => {
    migrationSessions();
    session("2026-05-28T09:00:00.000Z", "database migration for invoices");
    await analyze({ modelProvider: oneTaskPerMessage(() => "Write migrations").modelProvider, embedder: together(), clock: now });
    const [before] = (await workflows()).workflows;
    const provider = oneTaskPerMessage(namedByTopic);

    const report = await recluster({ modelProvider: provider.modelProvider, embedder: apart(), clock: now });

    const after = (await workflows()).workflows;
    const schema = after.find((w: any) => w.name === "Write schema migrations");
    expect(report.mapped).toEqual([{ from: { id: before.id, name: "Write migrations" }, to: { id: before.id, name: "Write migrations" } }]);
    expect(report.created).toEqual([{ id: schema.id, name: "Write schema migrations" }]);
    expect(schema.id).not.toBe(before.id);
    expect(after.find((w: any) => w.id === before.id).tasks).toHaveLength(4);
    expect(report.usage.map((u: any) => u.model)).toEqual(["mock-cheap"]);
  });

  it("keeps an old Workflow's id pointing at the Workflow it mapped to", async () => {
    migrationSessions();
    const modelProvider = oneTaskPerMessage(namedByTopic).modelProvider;
    await analyze({ modelProvider, embedder: apart(), clock: now });
    const before = (await workflows()).workflows;
    const database = before.find((w: any) => w.name === "Write database migrations");
    const schema = before.find((w: any) => w.name === "Write schema migrations");
    await recluster({ modelProvider, embedder: together(), clock: now });

    const shown = await runCli(home, ["workflow", String(schema.id), "--json"]);

    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.json().workflow).toMatchObject({ id: database.id, name: "Write database migrations" });
    expect(shown.json().workflow.tasks).toHaveLength(6);
  });

  it("moves Suggestions written for an old Workflow to the Workflow it mapped to", async () => {
    migrationSessions();
    const skill = { title: "Write a migration", trigger: "Use when changing a table.", steps: ["Write it.", "Run it."] };
    const modelProvider = scriptedModelProvider((request) =>
      request.includes("<workflow") ? skill : oneTaskPerMessageReply(request, namedByTopic),
    ).modelProvider;
    await analyze({ modelProvider, embedder: apart(), clock: now });
    const database = (await workflows()).workflows.find((w: any) => w.name === "Write database migrations");
    const suggested = await runCli(home, ["suggest", "--json"], { modelProvider, clock: now });
    expect(suggested.json().created).toHaveLength(2);

    await recluster({ modelProvider, embedder: together(), clock: now });

    const review = (await runCli(home, ["review", "--json"])).json().suggestions;
    expect(review.map((s: any) => s.workflow)).toEqual([
      { id: database.id, name: "Write database migrations" },
      { id: database.id, name: "Write database migrations" },
    ]);
    // The merged Workflow holds no Tasks those Suggestions weren't derived from, so it needs no new one.
    const again = await runCli(home, ["suggest", "--json"], { modelProvider, clock: now });
    expect(again.json()).toMatchObject({ created: [], replaced: [] });
  });

  it("rebuilds Correction Clusters too, keeping the identity of the one each maps to", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration", "no, use pnpm here", "no, not yarn");
    session("2026-05-20T09:00:00.000Z", "add a database migration", "no, pnpm please", "no, yarn is wrong");
    session("2026-05-25T09:00:00.000Z", "database migration for carts", "no, run it with pnpm");
    const modelProvider = scriptedModelProvider((request) => {
      const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
      if (messages.length === 0) return { name: request.includes("pnpm") ? "Use pnpm" : "Avoid yarn" };
      return {
        tasks: [
          {
            title: messages[0]![2],
            messages: messages.map(([, index], i) => ({ index: Number(index), intent: i === 0 ? "New Task" : "Correction" })),
          },
        ],
      };
    }).modelProvider;
    await analyze({ modelProvider, embedder: topicEmbedder(["database migration", "pnpm", "yarn"], "apart"), clock: now });
    const before = await runCli(home, ["corrections", "--json"]);
    const pnpm = before.json().correctionClusters.find((c: any) => c.name === "Use pnpm");
    const yarn = before.json().nearCorrectionClusters.find((c: any) => c.name === "Avoid yarn");

    const report = await recluster({ modelProvider, embedder: topicEmbedder(["database migration", "no, "], "together"), clock: now });

    expect(report.corrections.mapped).toEqual([
      { from: { id: pnpm.id, name: "Use pnpm" }, to: { id: pnpm.id, name: "Use pnpm" } },
      { from: { id: yarn.id, name: "Avoid yarn" }, to: { id: pnpm.id, name: "Use pnpm" } },
    ]);
    const after = (await runCli(home, ["corrections", "--json"])).json();
    expect(after.correctionClusters.map((c: any) => [c.id, c.name, c.corrections.length])).toEqual([[pnpm.id, "Use pnpm", 5]]);
    expect(after.nearCorrectionClusters).toEqual([]);
  });

  it("explains that there is nothing to re-cluster before any Analysis", async () => {
    const result = await runCli(home, ["recluster"], { embedder: apart() });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("No Clusters yet");
  });
});
