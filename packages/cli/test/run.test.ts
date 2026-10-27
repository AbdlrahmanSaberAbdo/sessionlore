import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, writeConfig, type CliResult, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

/** These tests run real servers, so they get more than the default 5s. */
const SLOW = 30_000;

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const now = fixedClock("2026-06-01T12:00:00.000Z");

const migrationSkill = {
  title: "Write a database migration",
  trigger: "Use when adding or changing a database table.",
  steps: ["Create a migration file in db/migrations.", "Run the migration locally.", "Add a rollback."],
};

/** Splits every Session into one Task per User Message, names Clusters, and writes a Skill for any Workflow. */
function modelProvider(onRequest: (request: string) => void = () => {}) {
  return scriptedModelProvider((request) => {
    onRequest(request);
    if (request.includes("<workflow")) return migrationSkill;
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) return { name: "Write database migrations" };
    return { tasks: messages.map(([, index, text]) => ({ title: text, messages: [{ index: Number(index), intent: "New Task" }] })) };
  });
}

function session(startedAt: string, ...requests: string[]) {
  return writeClaudeSession(home, {
    cwd: home.gitRepo("code/shop"),
    startedAt,
    turns: requests.flatMap((r) => [turn.user(r), turn.assistant("Done.")]),
  });
}

/** Three Sessions in the last 30 days that repeat one Workflow, and one older Session. */
function repeatedWorkflow() {
  session("2026-03-01T09:00:00.000Z", "write the release notes");
  session("2026-05-20T09:00:00.000Z", "add a database migration for users");
  session("2026-05-24T09:00:00.000Z", "add a database migration for orders");
  session("2026-05-28T09:00:00.000Z", "add a database migration for invoices");
}

function options(provider = modelProvider()): RunOptions & { requests(): string[] } {
  return {
    modelProvider: provider.modelProvider,
    embedder: topicEmbedder(["database migration", "release notes"]),
    clock: now,
    requests: provider.requests,
  };
}

/**
 * Starts `args` (a `run`), and resolves once it opens the browser, with the URL
 * and a way to stop it as Ctrl-C would; or with its result if it exits first.
 */
async function startRun(args: string[], opts: RunOptions = {}): Promise<{ url: string; stop(): Promise<CliResult> } | { exited: CliResult }> {
  const stop = new AbortController();
  let opened!: (url: string) => void;
  const browserUrl = new Promise<string>((resolve) => (opened = resolve));
  const run = runCli(home, [...args, "--port", "0"], { ...opts, signal: stop.signal, openBrowser: opened });
  return Promise.race([
    browserUrl.then((url) => ({ url, stop: async () => (stop.abort(), run) })),
    run.then((exited) => ({ exited })),
  ]);
}

async function served(args: string[], opts: RunOptions) {
  const started = await startRun(args, opts);
  if ("exited" in started) throw new Error(`run exited early (${started.exited.exitCode}): ${started.exited.stderr}${started.exited.stdout}`);
  return started;
}

async function storedSessions(): Promise<string[]> {
  return (await runCli(home, ["sessions", "--json"])).json().sessions.map((s: { startedAt: string }) => s.startedAt.slice(0, 10));
}

describe("run", { timeout: SLOW }, () => {
  it("without a Model Provider still scans, then says how to configure one and exits without serving", async () => {
    repeatedWorkflow();

    const started = await startRun(["run"], { clock: now });

    expect("exited" in started).toBe(true);
    const result = (started as { exited: CliResult }).exited;
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^ {2}Claude Code +~\/\.claude\/projects +3 Sessions, 3 new$/m);
    expect(result.stderr).toContain('"modelProvider"');
    expect(result.stderr).toContain('"apiKeyEnv": "ANTHROPIC_API_KEY"');
    expect(result.stderr).toContain("export SESSIONLORE_PROVIDER=");
    expect(result.stderr).toContain("export SESSIONLORE_API_KEY=");
    expect(await storedSessions()).toEqual(["2026-05-28", "2026-05-24", "2026-05-20"]);
  });

  it("scans the last 30 days, analyzes, suggests, and serves Home, after one combined estimate", async () => {
    repeatedWorkflow();
    const opts = options();

    const run = await served(["run", "--yes"], opts);
    const url = new URL(run.url);
    const queue = await (await fetch(new URL("/api/suggestions", url))).json();
    const result = await run.stop();

    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/");
    expect(queue.suggestions.map((s: { title: string }) => s.title)).toEqual(["Write a database migration"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Analysis: 3 new or changed Sessions\n");
    expect(result.stdout).toMatch(/^ {2}mock-cheap +about [\d,]+ input \+ [\d,]+ output tokens +cost unknown$/m);
    // Before Analysis no Workflow exists yet: the 3 new Tasks can form at most one Workflow and one Correction Cluster.
    expect(result.stdout).toContain("Suggestions: one per Workflow or repeated Correction found, at most 2\n");
    expect(result.stdout).toMatch(/^ {2}mock-strong +at most [\d,]+ input \+ [\d,]+ output tokens +cost unknown$/m);
    expect(result.stdout).toContain("  3 Tasks across 3 Sessions\n");
    expect(result.stdout).toContain("  1 Workflow (similar Tasks done at least 3 times in at least 2 Sessions within 60 days), 0 close to repeating\n");
    expect(result.stdout).toContain("  0 repeated Corrections\n");
    expect(result.stdout).toContain("  1 new Suggestion to review\n");
    expect(result.stdout).toContain("Cost: unknown\n");
    expect(result.stdout).toMatch(/^ {2}mock-cheap +\d+ input \+ \d+ output tokens +cost unknown$/m);
    expect(result.stdout).toMatch(/^ {2}mock-strong +\d+ input \+ \d+ output tokens +cost unknown$/m);
    expect(result.stdout).toContain(run.url);
    expect(await storedSessions()).toEqual(["2026-05-28", "2026-05-24", "2026-05-20"]);
  });

  it("asks once before any model call and goes ahead on yes", async () => {
    repeatedWorkflow();
    const opts = options();

    const run = await served(["run"], { ...opts, answers: ["y"] });
    const result = await run.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.match(/Continue\? \[y\/N\]/g)).toHaveLength(1);
    expect(result.stdout).toContain("  1 new Suggestion to review\n");
  });

  it("sends no sampling settings, so models that reject them (newer Claude, OpenAI reasoning models) work", async () => {
    repeatedWorkflow();
    const provider = modelProvider();

    const run = await served(["run", "--yes"], options(provider));
    await run.stop();

    expect(provider.settings().length).toBeGreaterThan(0);
    for (const s of provider.settings()) expect(s).toEqual({ temperature: undefined, topP: undefined, topK: undefined });
  });

  it("shows its progress in a terminal", async () => {
    repeatedWorkflow();

    const run = await served(["run"], { ...options(), answers: ["y"] });
    const result = await run.stop();

    expect(result.stderr).toContain("Analyzed 3 of 3 Sessions");
    expect(result.stderr).toContain("Grouping similar Tasks and Corrections");
    expect(result.stderr).toContain("Wrote 1 of 1 Suggestion");
  });

  it("calls no model and serves nothing when the person declines", async () => {
    repeatedWorkflow();
    const opts = options();

    const started = await startRun(["run"], { ...opts, answers: ["n"] });

    expect("exited" in started).toBe(true);
    const result = (started as { exited: CliResult }).exited;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing analyzed.");
    expect(opts.requests()).toEqual([]);
  });

  it("without a terminal and without --yes, exits before spending anything", async () => {
    repeatedWorkflow();
    const opts = options();

    const started = await startRun(["run"], opts);

    expect("exited" in started).toBe(true);
    const result = (started as { exited: CliResult }).exited;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("`sessionlore run --yes`");
    expect(opts.requests()).toEqual([]);
    expect(await storedSessions()).toHaveLength(3);
  });

  it("with nothing new to analyze and nothing to suggest, skips the question and still opens the dashboard", async () => {
    repeatedWorkflow();
    const opts = options();
    await (await served(["run", "--yes"], opts)).stop();
    const before = opts.requests().length;

    // No --yes and no terminal: asking would fail.
    const run = await served(["run"], opts);
    const result = await run.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Nothing new to analyze and nothing to suggest.");
    expect(result.stdout).not.toContain("Continue?");
    expect(opts.requests()).toHaveLength(before);
    expect(new URL(run.url).pathname).toBe("/");
  });

  it("keeps finished Sessions when interrupted during Analysis, and serves nothing", async () => {
    repeatedWorkflow();
    const stop = new AbortController();
    let splits = 0;
    const provider = modelProvider((request) => {
      if (request.includes("<message index") && ++splits === 2) stop.abort();
    });
    let opened = false;

    const result = await runCli(home, ["run", "--yes", "--port", "0"], {
      ...options(provider),
      signal: stop.signal,
      openBrowser: () => (opened = true),
    });

    expect(result.exitCode).toBe(130);
    expect(result.stdout).toContain("Interrupted.");
    expect(opened).toBe(false);
    const tasks = (await runCli(home, ["tasks", "--json"])).json().sessions;
    expect(tasks).toHaveLength(1);
  });

  it("prints one JSON summary with --json", async () => {
    repeatedWorkflow();

    const run = await served(["run", "--yes", "--json"], options());
    const result = await run.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    const summary = result.json();
    expect(summary.url).toBe(run.url);
    expect(summary.found).toEqual({
      sessions: { added: 3, updated: 0 },
      tasks: 3,
      workflows: 1,
      nearWorkflows: 0,
      correctionClusters: 0,
      suggestionsWritten: 1,
    });
    expect(summary.usage.map((u: { model: string }) => u.model).sort()).toEqual(["mock-cheap", "mock-strong"]);
  });

  it("takes --since and --harness for its scan", async () => {
    repeatedWorkflow();

    const started = await startRun(["run", "--since", "2026-05-22", "--harness", "claude-code"], { clock: now });

    expect((started as { exited: CliResult }).exited.exitCode).toBe(1);
    expect(await storedSessions()).toEqual(["2026-05-28", "2026-05-24"]);
  });
});

describe("run explains what it did", { timeout: SLOW }, () => {
  it("says where it read each Harness's Sessions from, over which window, and that it only reads", async () => {
    repeatedWorkflow();

    const started = await startRun(["run"], { clock: now });
    const result = (started as { exited: CliResult }).exited;

    expect(result.stdout).toContain("Reading your Sessions from the last 30 days (read-only)\n");
    expect(result.stdout).toMatch(/^ {2}Claude Code {2}~\/\.claude\/projects {2}3 Sessions, 3 new$/m);
  });

  it("prints a cost under a cent as less than $0.01, never $0.00", async () => {
    repeatedWorkflow();
    writeConfig(home, {
      prices: { "mock-cheap": { inputPerMillion: 1, outputPerMillion: 1 }, "mock-strong": { inputPerMillion: 1, outputPerMillion: 1 } },
    });

    const result = await (await served(["run", "--yes"], options())).stop();

    expect(result.stdout).toMatch(/^ {2}mock-cheap +about [\d,]+ input \+ [\d,]+ output tokens +less than \$0\.01$/m);
    expect(result.stdout).toMatch(/^Cost: less than \$0\.01$/m);
    expect(result.stdout).not.toMatch(/\$0\.00(?!\d)/);
  });

  it("says how many Sessions are already analyzed and won't be charged again", async () => {
    repeatedWorkflow();
    const opts = options();
    await (await served(["run", "--yes"], opts)).stop();
    session("2026-05-30T09:00:00.000Z", "write the changelog");

    const result = await (await served(["run", "--yes"], opts)).stop();

    expect(result.stdout).toMatch(/^ {2}Claude Code +~\/\.claude\/projects +4 Sessions, 1 new$/m);
    expect(result.stdout).toContain("Analysis: 1 new or changed Session (3 already analyzed, not charged again)\n");
  });

  it("groups what it found under one heading, explaining a Workflow with the configured Repeat Rule", async () => {
    repeatedWorkflow();
    writeConfig(home, { repeatRule: { minSessions: 3, windowDays: 45 } });

    const result = await (await served(["run", "--yes"], options())).stop();

    expect(result.stdout).toContain(
      "\nFound in your analyzed Sessions\n" +
        "  3 Tasks across 3 Sessions\n" +
        "  1 Workflow (similar Tasks done at least 3 times in at least 3 Sessions within 45 days), 0 close to repeating\n" +
        "  0 repeated Corrections\n" +
        "  1 new Suggestion to review\n" +
        "Cost: ",
    );
    expect(result.stdout).toMatch(/\nReview it on Home: http:\/\/127\.0\.0\.1:\d+\/\n/);
  });

  it("says why it wrote no Suggestion when no Workflow repeats often enough yet", async () => {
    session("2026-05-20T09:00:00.000Z", "add a database migration for users");
    session("2026-05-24T09:00:00.000Z", "add a database migration for orders");

    const result = await (await served(["run", "--yes"], options())).stop();

    expect(result.stdout).toContain("  0 Workflows (similar Tasks done at least 3 times in at least 2 Sessions within 60 days), 1 close to repeating\n");
    expect(result.stdout).toContain(
      "  No new Suggestions: no Workflow or Correction repeats often enough yet (1 is close); scan more history with --since 90d\n",
    );
    expect(result.stdout).not.toContain("Suggestions written: 0");
  });
});

describe("sessionlore with no command", { timeout: SLOW }, () => {
  it("runs `run` with the defaults", async () => {
    repeatedWorkflow();

    const run = await served([], { ...options(), answers: ["y"] });
    const result = await run.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(new URL(run.url).pathname).toBe("/");
    expect(await storedSessions()).toEqual(["2026-05-28", "2026-05-24", "2026-05-20"]);
  });
});
