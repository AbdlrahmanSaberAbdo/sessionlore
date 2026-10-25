import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { createServer } from "@sessionlore/server";
import { openDemo, type Demo } from "../src/index.js";
import { snapshotTree } from "./support/files.js";
import { fixedClock, runCli } from "./support/harness.js";

/**
 * The demo dataset: synthetic Sessions built with the fixture builders,
 * analyzed into a separate demo store without a Model Provider, and served by
 * the dashboard. Read back through the dashboard's API (Seam 2) and the CLI (Seam 1).
 */

let root: string;
let home: FixtureHome;
let demo: Demo | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sessionlore-demo-root-")));
  home = FixtureHome.create();
});

afterEach(() => {
  demo?.close();
  demo = undefined;
  rmSync(root, { recursive: true, force: true });
  home.remove();
});

const clock = fixedClock("2026-06-01T12:00:00.000Z");

async function get(path: string) {
  demo ??= await openDemo({ root, clock });
  const response = await createServer({ app: demo.app }).fetch(new Request(new URL(path, "http://localhost")));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<any>;
}

describe("the demo dataset", () => {
  it("has Sessions from Claude Code and Cursor, Workflows and near-Workflows", async () => {
    const overview = await get("/api/overview");
    const workflows = await get("/api/workflows");

    expect(overview.counts.sessions).toBeGreaterThanOrEqual(8);
    expect(overview.counts.workflows).toBeGreaterThanOrEqual(2);
    expect(overview.corrections.periods.some((p: any) => p.corrections > 0)).toBe(true);
    expect(workflows.filters.harnesses).toEqual(["claude-code", "cursor"]);
    expect(workflows.workflows.map((w: any) => w.name)).toEqual(
      expect.arrayContaining(["Write database migrations", "Update the release notes"]),
    );
    expect(workflows.workflows.some((w: any) => w.harnesses.includes("cursor") && w.harnesses.includes("claude-code"))).toBe(true);
    expect(workflows.nearWorkflows.length).toBeGreaterThanOrEqual(1);
  });

  it("has Correction Clusters and Pending Suggestions, one of them with a Target", async () => {
    demo = await openDemo({ root, clock });
    const corrections = demo.app.listCorrections();
    const queue = await get("/api/suggestions");

    expect(corrections.correctionClusters.map((c) => c.name)).toContain("Use pnpm, not npm");
    expect(queue.suggestions.map((s: any) => s.kind).sort()).toEqual(["rule", "skill", "skill"]);
    const targeted = queue.suggestions.find((s: any) => s.target);
    expect(targeted.target).toMatchObject({ kind: "rule", line: "- Always run things with pnpm." });
    expect(targeted.target.path.startsWith(demo.home)).toBe(true);
  });

  it("has a Mind map and a Session viewer with Tasks and Corrections", async () => {
    const map = await get("/api/mind-map");
    const sessions = await get("/api/sessions");
    const viewed = await Promise.all(sessions.sessions.map((s: any) => get(`/api/sessions/${s.id}`)));

    expect(new Set(map.nodes.map((n: any) => n.kind))).toEqual(new Set(["project", "workflow", "task", "session", "suggestion"]));
    expect(viewed.some((s) => s.messages.some((m: any) => m.intent === "Correction"))).toBe(true);
    expect(viewed.some((s) => s.tasks.some((t: any) => t.workflow !== null))).toBe(true);
  });

  it("lives inside its own folder under the root it is given, and is removed on close", async () => {
    demo = await openDemo({ root, clock });
    const demoHome = demo.home;

    expect(demoHome.startsWith(root)).toBe(true);
    demo.close();
    demo = undefined;
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("sessionlore demo", () => {
  /** Starts `demo`, waits until it opens the browser, and returns the URL plus a way to stop it. */
  async function startDemo() {
    const stop = new AbortController();
    let opened!: (url: string) => void;
    const browserUrl = new Promise<string>((resolve) => (opened = resolve));
    const run = runCli(home, ["demo", "--port", "0"], { signal: stop.signal, openBrowser: opened, demoRoot: root });
    const url = await Promise.race([browserUrl, run.then((r) => Promise.reject(new Error(`demo exited early: ${r.stderr}`)))]);
    return { url, stop: async () => (stop.abort(), run) };
  }

  it("serves the demo dashboard with no Model Provider, no Harness data and no store of the person's own", async () => {
    const before = snapshotTree(home.path);

    const running = await startDemo();
    const overview = await (await fetch(new URL("/api/overview", running.url))).json();
    const result = await running.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(running.url);
    expect(overview.counts.workflows).toBeGreaterThanOrEqual(2);
    expect(snapshotTree(home.path)).toEqual(before);
    expect(readdirSync(root)).toEqual([]);
  });

  it("never mixes with the person's real store", async () => {
    writeClaudeSession(home, { cwd: home.gitRepo("code/mine"), startedAt: "2026-05-04T09:00:00.000Z", turns: [turn.user("my own work")] });
    expect((await runCli(home, ["scan"])).exitCode).toBe(0);
    const store = snapshotTree(home.resolve(".sessionlore"));

    const running = await startDemo();
    const sessions = await (await fetch(new URL("/api/sessions", running.url))).json();
    await running.stop();

    expect(sessions.sessions.some((s: any) => s.project?.name === "mine")).toBe(false);
    expect(snapshotTree(home.resolve(".sessionlore"))).toEqual(store);
    expect((await runCli(home, ["sessions", "--json"])).json().sessions).toHaveLength(1);
  });
});
