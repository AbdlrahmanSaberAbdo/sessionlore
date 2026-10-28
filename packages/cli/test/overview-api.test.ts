import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@habitlore/fixtures";
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
 * of migration Tasks are named "Write database migrations".
 */
const provider = scriptedModelProvider((request) => {
  const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
  if (messages.length === 0) return { name: request.includes("migration") ? "Write database migrations" : "Other" };
  const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
  for (const [, index, text] of messages) {
    if (text!.startsWith("no,") && tasks.length > 0) tasks.at(-1)!.messages.push({ index: Number(index), intent: "Correction" });
    else tasks.push({ title: text!, messages: [{ index: Number(index), intent: "New Task" }] });
  }
  return { tasks };
});

const options: RunOptions = {
  modelProvider: provider.modelProvider,
  embedder: topicEmbedder(["database migration"]),
  clock: fixedClock("2026-06-01T12:00:00.000Z"),
};

function session(repo: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd: home.gitRepo(repo),
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

async function scanAndAnalyze() {
  expect((await runCli(home, ["scan"], options)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], options);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

describe("overview API", () => {
  it("counts Sessions, Tasks and Workflows, lists top Workflows and Corrections per week", async () => {
    // Monday 2026-05-04: two Corrections.
    session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders", "no, use a transaction", "no, name it 0042");
    // Wednesday 2026-05-20: none.
    session("code/shop", "2026-05-20T09:00:00.000Z", "add a database migration for users", "update the release notes");
    // Tuesday 2026-05-26: one.
    session("code/blog", "2026-05-26T09:00:00.000Z", "database migration for the cart table", "no, keep the old column");
    await scanAndAnalyze();

    api = openApi(home, options);
    const response = await api.get("/api/overview");

    expect(response.status).toBe(200);
    const overview = response.json();
    expect(overview.counts).toEqual({ sessions: 3, tasks: 4, workflows: 1 });
    expect(overview.topWorkflows).toEqual([
      { id: expect.any(Number), name: "Write database migrations", tasks: 3, sessions: 3 },
    ]);
    // Weeks start on Monday (UTC) and run up to the current week, with empty weeks included.
    expect(overview.corrections).toEqual({
      period: "week",
      periods: [
        { start: "2026-05-04", corrections: 2 },
        { start: "2026-05-11", corrections: 0 },
        { start: "2026-05-18", corrections: 0 },
        { start: "2026-05-25", corrections: 1 },
        { start: "2026-06-01", corrections: 0 },
      ],
    });
  });

  it("is empty before anything is scanned", async () => {
    api = openApi(home, options);

    const overview = (await api.get("/api/overview")).json();

    expect(overview).toEqual({
      counts: { sessions: 0, tasks: 0, workflows: 0 },
      topWorkflows: [],
      corrections: { period: "week", periods: [] },
    });
  });

  it("leaves out Projects the config file excludes", async () => {
    session("code/shop", "2026-05-04T09:00:00.000Z", "write a database migration for orders", "no, use a transaction");
    session("code/blog", "2026-05-26T09:00:00.000Z", "update the release notes", "no, shorter");
    await scanAndAnalyze();
    writeConfig(home, { projects: { exclude: ["shop"] } });

    api = openApi(home, options);
    const overview = (await api.get("/api/overview")).json();

    expect(overview.counts).toEqual({ sessions: 1, tasks: 1, workflows: 0 });
    expect(overview.corrections.periods).toEqual([
      { start: "2026-05-25", corrections: 1 },
      { start: "2026-06-01", corrections: 0 },
    ]);
  });

  it("answers an unknown API path with a JSON 404", async () => {
    api = openApi(home, options);

    const response = await api.get("/api/nothing-here");

    expect(response.status).toBe(404);
    expect(response.json()).toEqual({ error: expect.stringContaining("/api/nothing-here") });
  });
});

describe("dashboard UI", () => {
  function builtUi() {
    const dir = home.folder("built-ui");
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>habitlore</title><div id=root></div>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app-1234.js"), "console.log('ui')");
    return dir;
  }

  it("serves the built UI's index page and its assets", async () => {
    api = openApi(home, { ...options, uiDir: builtUi() });

    const page = await api.get("/");
    const script = await api.get("/assets/app-1234.js");

    expect(page.status).toBe(200);
    expect(page.contentType).toContain("text/html");
    expect(page.text).toContain("<title>habitlore</title>");
    expect(script.status).toBe(200);
    expect(script.contentType).toContain("text/javascript");
  });

  it("serves the index page for the UI's own routes, so they can be reloaded", async () => {
    api = openApi(home, { ...options, uiDir: builtUi() });

    const page = await api.get("/workflows");

    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>habitlore</title>");
  });

  it("serves nothing outside the UI folder", async () => {
    writeFileSync(home.resolve("secret.txt"), "do not serve");
    api = openApi(home, { ...options, uiDir: builtUi() });

    const response = await api.get("/..%2fsecret.txt");

    expect(response.text).not.toContain("do not serve");
  });

  it("says how to build the UI when it is missing", async () => {
    api = openApi(home, options);

    const page = await api.get("/");

    expect(page.status).toBe(503);
    expect(page.text).toContain("not built");
  });
});
