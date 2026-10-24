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
 * A Model Provider that labels User Messages by how they start: "no, ..." is a
 * Correction and "also ..." a Follow-up, both in the Task before them; any
 * other message starts a New Task titled with its text. Clusters and
 * Correction Clusters are named with `name`.
 */
function labelledByPrefix(name: (request: string) => string = () => "Some name") {
  return scriptedModelProvider((request) => {
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) return { name: name(request) };
    const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
    for (const [, index, text] of messages) {
      const intent = text!.startsWith("no,") ? "Correction" : text!.startsWith("also") ? "Follow-up" : "New Task";
      if (intent === "New Task" || tasks.length === 0) tasks.push({ title: text!, messages: [] });
      tasks.at(-1)!.messages.push({ index: Number(index), intent });
    }
    return { tasks };
  });
}

function session(startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd: home.gitRepo("code/shop"),
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");
const topics = ["database migration", "release notes", "pnpm"];

async function analyze(options: RunOptions) {
  expect((await runCli(home, ["scan"], options)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], options);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

async function corrections(options: RunOptions = {}) {
  const result = await runCli(home, ["corrections", "--json"], options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

describe("corrections", () => {
  it("groups similar Corrections from Tasks in different Workflows into one named Correction Cluster", async () => {
    const first = session(
      "2026-05-10T09:00:00.000Z",
      "write a database migration for orders",
      "no, use pnpm not npm to run it",
      "update the release notes",
    );
    const second = session(
      "2026-05-20T09:00:00.000Z",
      "add a database migration for users",
      "release notes for 2.0",
      "no, we use pnpm here",
    );
    const third = session("2026-05-25T09:00:00.000Z", "release notes for 2.1", "no, pnpm please");
    const provider = labelledByPrefix((request) => (request.includes("<correction>") ? "Use pnpm, not npm" : "Other"));
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(topics), clock: now };

    await analyze(options);
    const result = await corrections(options);

    expect(result.correctionClusters).toHaveLength(1);
    const [cluster] = result.correctionClusters;
    expect(cluster.name).toBe("Use pnpm, not npm");
    expect(cluster.corrections.map((c: any) => [c.text, c.task, c.session])).toEqual([
      ["no, use pnpm not npm to run it", "write a database migration for orders", first.id],
      ["no, we use pnpm here", "release notes for 2.0", second.id],
      ["no, pnpm please", "release notes for 2.1", third.id],
    ]);
    expect(cluster.corrections[0]).toMatchObject({ harness: "claude-code", project: { name: "shop" } });
    expect(cluster.sessions.map((s: any) => s.id)).toEqual([first.id, second.id, third.id]);
    expect(cluster.counted).toEqual({ corrections: 3, sessions: 3 });
  });

  it("qualifies a Correction Cluster with 3 Corrections in 2 Sessions within 60 days", async () => {
    session("2026-05-10T09:00:00.000Z", "write a database migration for orders", "no, use pnpm", "no, pnpm again");
    session("2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here");
    const provider = labelledByPrefix(() => "Use pnpm, not npm");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(topics), clock: now };

    await analyze(options);
    const result = await corrections(options);

    expect(result.repeatRule).toEqual({ minMembers: 3, minSessions: 2, windowDays: 60 });
    expect(result.correctionClusters.map((c: any) => [c.name, c.counted])).toEqual([
      ["Use pnpm, not npm", { corrections: 3, sessions: 2 }],
    ]);
    expect(result.nearCorrectionClusters).toEqual([]);
  });

  it("does not qualify 3 Corrections in one Session, 2 Corrections, or Corrections older than 60 days", async () => {
    session("2026-05-10T09:00:00.000Z", "fix the build", "no, use pnpm", "no, pnpm again", "no, pnpm please");
    session("2026-05-11T09:00:00.000Z", "update the release notes", "no, the release notes go in CHANGELOG.md");
    session("2026-05-12T09:00:00.000Z", "release notes for 2.0", "no, release notes go in CHANGELOG.md");
    session("2026-03-01T09:00:00.000Z", "write a database migration", "no, a database migration needs a down step");
    session("2026-03-02T09:00:00.000Z", "add a database migration", "no, database migration files are timestamped");
    session("2026-03-03T09:00:00.000Z", "database migration for users", "no, database migration first, then code");
    const provider = labelledByPrefix((request) =>
      request.includes("pnpm") ? "Use pnpm" : request.includes("release notes") ? "Keep release notes in CHANGELOG.md" : "Migrations",
    );
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(topics), clock: now };

    await analyze(options);
    const result = await corrections(options);

    expect(result.correctionClusters).toEqual([]);
    expect(result.nearCorrectionClusters.map((c: any) => [c.name, c.counted, c.needs])).toEqual([
      ["Use pnpm", { corrections: 3, sessions: 1 }, { corrections: 0, sessions: 1 }],
      ["Keep release notes in CHANGELOG.md", { corrections: 2, sessions: 2 }, { corrections: 1, sessions: 0 }],
    ]);
  });

  it("never puts Follow-ups or other non-Correction User Messages into Correction Clusters", async () => {
    session("2026-05-10T09:00:00.000Z", "set up pnpm workspaces", "also use pnpm for the lockfile", "no, use pnpm not npm");
    session("2026-05-20T09:00:00.000Z", "fix the pnpm install", "also pnpm in CI", "no, pnpm please");
    session("2026-05-25T09:00:00.000Z", "release notes", "no, we use pnpm here");
    const provider = labelledByPrefix(() => "Use pnpm, not npm");
    const options = { modelProvider: provider.modelProvider, embedder: topicEmbedder(topics), clock: now };

    await analyze(options);
    const result = await corrections(options);

    const listed = [...result.correctionClusters, ...result.nearCorrectionClusters].flatMap((c: any) =>
      c.corrections.map((m: any) => m.text),
    );
    expect(listed).toEqual(["no, use pnpm not npm", "no, pnpm please", "no, we use pnpm here"]);
  });

  it("drops a Correction from its Correction Cluster when a new Analysis no longer labels it a Correction", async () => {
    const first = session("2026-05-10T09:00:00.000Z", "fix the build", "no, use pnpm");
    session("2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here", "no, pnpm please");
    const options = { modelProvider: labelledByPrefix(() => "Use pnpm").modelProvider, embedder: topicEmbedder(topics), clock: now };
    await analyze(options);
    expect((await corrections(options)).correctionClusters).toHaveLength(1);

    // The first Session gets a new message, so it is analyzed again; this time nothing in it is a Correction.
    writeClaudeSession(home, {
      id: first.id,
      cwd: home.gitRepo("code/shop"),
      startedAt: "2026-05-10T09:00:00.000Z",
      turns: ["fix the build", "no, use pnpm", "thanks"].flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
    });
    const relabelled = scriptedModelProvider((request) =>
      request.includes("<message")
        ? { tasks: [{ title: "fix the build", messages: [0, 1, 2].map((index) => ({ index, intent: "Follow-up" })) }] }
        : { name: "Use pnpm" },
    );
    await analyze({ ...options, modelProvider: relabelled.modelProvider });

    const result = await corrections(options);
    expect(result.correctionClusters).toEqual([]);
    expect(result.nearCorrectionClusters.map((c: any) => c.corrections.map((m: any) => m.text))).toEqual([
      ["no, we use pnpm here", "no, pnpm please"],
    ]);
  });
});
