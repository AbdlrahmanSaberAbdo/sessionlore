import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { snapshotTree } from "./support/files.js";
import { runCli } from "./support/harness.js";

/**
 * `sessionlore demo`: synthetic Sessions built with the fixture builders,
 * analyzed into a separate demo store without a Model Provider, and served by
 * the dashboard. Started through the CLI (Seam 1) and read back over HTTP.
 */

/** These tests run real servers and the demo's full scripted Analysis, so they get more than the default 5s. */
const SLOW = 30_000;

let root: string;
let home: FixtureHome;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sessionlore-demo-root-")));
  home = FixtureHome.create();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  home.remove();
});

/** Starts `demo` with its throwaway home under `demoRoot`, waits until it opens the browser, and returns the URL plus a way to stop it. */
async function startDemo(cliHome: FixtureHome, demoRoot: string, args: string[] = []) {
  const stop = new AbortController();
  let opened!: (url: string) => void;
  const browserUrl = new Promise<string>((resolve) => (opened = resolve));
  const run = runCli(cliHome, ["demo", "--port", "0", ...args], { signal: stop.signal, openBrowser: opened, demoRoot });
  const url = await Promise.race([browserUrl, run.then((r) => Promise.reject(new Error(`demo exited early: ${r.stderr}`)))]);
  const get = async (path: string): Promise<any> => {
    const response = await fetch(new URL(path, url));
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  return { url, get, stop: async () => (stop.abort(), run) };
}

describe("the demo dataset", { timeout: SLOW }, () => {
  // One demo serves every test here: each run analyzes the whole dataset.
  let datasetRoot: string;
  let datasetHome: FixtureHome;
  let demo: Awaited<ReturnType<typeof startDemo>>;

  beforeAll(async () => {
    datasetRoot = realpathSync(mkdtempSync(join(tmpdir(), "sessionlore-demo-dataset-")));
    datasetHome = FixtureHome.create();
    demo = await startDemo(datasetHome, datasetRoot);
  }, SLOW);

  afterAll(async () => {
    await demo?.stop();
    rmSync(datasetRoot, { recursive: true, force: true });
    datasetHome.remove();
  });

  it("has Sessions from Claude Code and Cursor, Workflows and near-Workflows", async () => {
    const overview = await demo.get("/api/overview");
    const workflows = await demo.get("/api/workflows");

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

  it("has a Correction Cluster's Rule and Pending Skills, one of them with a Target inside the demo's own folder", async () => {
    const queue = await demo.get("/api/suggestions");
    const reviews = await Promise.all(queue.suggestions.map((s: any) => demo.get(`/api/suggestions/${s.id}`)));

    expect(queue.suggestions.map((s: any) => s.kind).sort()).toEqual(["rule", "skill", "skill"]);
    const rule = reviews.find((r) => r.suggestion.kind === "rule");
    expect(rule.suggestion.correctionCluster.name).toBe("Use pnpm, not npm");
    const targeted = queue.suggestions.find((s: any) => s.target);
    expect(targeted.target).toMatchObject({ kind: "rule", line: "- Always run things with pnpm." });
    expect(targeted.target.path.startsWith(datasetRoot)).toBe(true);
  });

  it("has a Mind map and a Session viewer with Tasks and Corrections", async () => {
    const map = await demo.get("/api/mind-map");
    const sessions = await demo.get("/api/sessions");
    const viewed = await Promise.all(sessions.sessions.map((s: any) => demo.get(`/api/sessions/${s.id}`)));

    expect(new Set(map.nodes.map((n: any) => n.kind))).toEqual(new Set(["project", "workflow", "task", "session", "suggestion"]));
    expect(viewed.some((s) => s.messages.some((m: any) => m.intent === "Correction"))).toBe(true);
    expect(viewed.some((s) => s.tasks.some((t: any) => t.workflow !== null))).toBe(true);
  });

  it("lives inside its own folder under the root it is given while it runs", () => {
    expect(readdirSync(datasetRoot)).toHaveLength(1);
  });
});

describe("sessionlore demo", { timeout: SLOW }, () => {
  it("serves the demo dashboard with no Model Provider, no Harness data and no store of the person's own", async () => {
    const before = snapshotTree(home.path);

    const running = await startDemo(home, root);
    const overview = await (await fetch(new URL("/api/overview", running.url))).json();
    const result = await running.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(running.url);
    expect(overview.counts.workflows).toBeGreaterThanOrEqual(2);
    expect(snapshotTree(home.path)).toEqual(before);
    expect(readdirSync(root)).toEqual([]);
  });

  it("prints the dashboard's address and a summary of the dataset as JSON with --json", async () => {
    const running = await startDemo(home, root, ["--json"]);
    const result = await running.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    const printed = result.json();
    expect(printed.url).toBe(running.url);
    expect(printed.dataset.sessions).toBeGreaterThanOrEqual(8);
    expect(printed.dataset.workflows).toBeGreaterThanOrEqual(2);
    expect(printed.dataset.correctionClusters).toBeGreaterThanOrEqual(1);
    expect(printed.dataset.pendingSuggestions).toBe(3);
    expect(printed.dataset.harnesses).toEqual(["claude-code", "cursor"]);
  });

  it("never mixes with the person's real store", async () => {
    writeClaudeSession(home, { cwd: home.gitRepo("code/mine"), startedAt: "2026-05-04T09:00:00.000Z", turns: [turn.user("my own work")] });
    expect((await runCli(home, ["scan"])).exitCode).toBe(0);
    const store = snapshotTree(home.resolve(".sessionlore"));

    const running = await startDemo(home, root);
    const sessions = await (await fetch(new URL("/api/sessions", running.url))).json();
    await running.stop();

    expect(sessions.sessions.some((s: any) => s.project?.name === "mine")).toBe(false);
    expect(snapshotTree(home.resolve(".sessionlore"))).toEqual(store);
    expect((await runCli(home, ["sessions", "--json"])).json().sessions).toHaveLength(1);
  });
});
