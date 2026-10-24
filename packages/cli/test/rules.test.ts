import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const pnpmRule = { title: "Use pnpm", rule: "Use pnpm, never npm, to install packages and run scripts." };

/**
 * Labels User Messages by how they start: "no, ..." is a Correction in the
 * Task before it, anything else starts a New Task titled with its text. Names
 * every Cluster after its first topic, and writes `rule` for any Correction
 * Cluster it is asked about.
 */
function modelProvider(rule: (request: string) => object = () => pnpmRule) {
  return scriptedModelProvider((request) => {
    if (request.includes("<correction-cluster")) return rule(request);
    if (request.includes("<workflow")) return { title: "Some skill", trigger: "Use when.", steps: ["Do it."] };
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) {
      return { name: request.includes("pnpm") ? "Use pnpm, not npm" : request.includes("tabs") ? "Indent with tabs" : "Other" };
    }
    const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
    for (const [, index, text] of messages) {
      const intent = text!.startsWith("no,") ? "Correction" : "New Task";
      if (intent === "New Task" || tasks.length === 0) tasks.push({ title: text!, messages: [] });
      tasks.at(-1)!.messages.push({ index: Number(index), intent });
    }
    return { tasks };
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");

function options(provider = modelProvider()): RunOptions & { requests(): string[] } {
  return {
    modelProvider: provider.modelProvider,
    embedder: topicEmbedder(["pnpm", "tabs", "database migration", "release notes"]),
    clock: now,
    requests: provider.requests,
  };
}

function session(cwd: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd,
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

async function analyze(opts: RunOptions) {
  expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], opts);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

async function suggest(opts: RunOptions) {
  const result = await runCli(home, ["suggest", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

async function review(opts: RunOptions = {}) {
  const result = await runCli(home, ["review", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json().suggestions;
}

/** Three "use pnpm" Corrections across three Sessions in `shop`: a qualifying Correction Cluster, and no Workflow. */
function pnpmCorrectionsIn(cwd: string) {
  return [
    session(cwd, "2026-05-10T09:00:00.000Z", "write a database migration for orders", "no, use pnpm not npm to run it"),
    session(cwd, "2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here"),
    session(cwd, "2026-05-25T09:00:00.000Z", "fix the build", "no, pnpm please"),
  ];
}

describe("suggest Rules", () => {
  it("writes one Pending Rule Suggestion per qualifying Correction Cluster, with the Corrections as Evidence", async () => {
    const shop = home.gitRepo("code/shop");
    const sessions = pnpmCorrectionsIn(shop);
    // Two Corrections about tabs: a near Correction Cluster, which earns no Rule.
    session(shop, "2026-05-26T09:00:00.000Z", "format the file", "no, indent with tabs");
    session(shop, "2026-05-27T09:00:00.000Z", "add a helper", "no, tabs not spaces");
    const opts = options();
    await analyze(opts);

    const result = await suggest(opts);

    expect(result.created).toHaveLength(1);
    const strongRequests = opts.requests().filter((r) => r.includes("<correction-cluster"));
    expect(strongRequests).toHaveLength(1);
    expect(strongRequests[0]).toContain("no, we use pnpm here");
    expect(strongRequests[0]).not.toContain("tabs");

    const [suggestion, ...others] = await review();
    expect(others).toEqual([]);
    expect(suggestion).toMatchObject({
      id: result.created[0],
      kind: "rule",
      state: "Pending",
      title: "Use pnpm",
      rule: "Use pnpm, never npm, to install packages and run scripts.",
      correctionCluster: { name: "Use pnpm, not npm" },
      scope: { kind: "project", project: { name: "shop", path: shop } },
    });
    const project = { name: "shop", path: shop };
    expect(suggestion.evidence).toEqual([
      {
        correction: { text: "no, use pnpm not npm to run it", at: expect.any(String) },
        task: { title: "write a database migration for orders", at: "2026-05-10T09:00:00.000Z" },
        session: { id: sessions[0]!.id, harness: "claude-code" },
        project,
      },
      {
        correction: { text: "no, we use pnpm here", at: expect.any(String) },
        task: { title: "update the release notes", at: "2026-05-20T09:00:00.000Z" },
        session: { id: sessions[1]!.id, harness: "claude-code" },
        project,
      },
      {
        correction: { text: "no, pnpm please", at: expect.any(String) },
        task: { title: "fix the build", at: "2026-05-25T09:00:00.000Z" },
        session: { id: sessions[2]!.id, harness: "claude-code" },
        project,
      },
    ]);
  });
});
