import { appendFileSync, utimesSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli, writeConfig } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const oneTask = { tasks: [{ title: "Do it", messages: [{ index: 0, intent: "New Task" }] }] };

function writeSessions(...firstMessages: string[]) {
  const repo = home.gitRepo("code/shop");
  return firstMessages.map((text, i) =>
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: `2026-05-0${i + 1}T09:00:00.000Z`,
      turns: [turn.user(text)],
    }),
  );
}

describe("reliable Analysis", () => {
  it("when the Model Provider fails for one Session, analyzes the others and lists the failure", async () => {
    const [cart, node, docs] = writeSessions("rename the cart module", "bump the node version", "update the docs");
    const provider = scriptedModelProvider((request) => {
      if (request.includes("node version")) throw new Error("503 Service Unavailable");
      return oneTask;
    });
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toContain("2 Sessions analyzed");
    expect(analyze.stdout).toContain("1 Session failed");
    expect(analyze.stdout).toContain(`${node!.id}: 503 Service Unavailable`);
    const { sessions } = (await runCli(home, ["tasks", "--json"])).json();
    expect(sessions.map((s: any) => s.id).sort()).toEqual([cart!.id, docs!.id].sort());
  });

  it("an interrupted Analysis processes only the remaining Sessions when run again", async () => {
    writeSessions("rename the cart module", "bump the node version", "update the docs");
    const interrupt = new AbortController();
    const provider = scriptedModelProvider((request) => {
      if (request.includes("node version")) interrupt.abort();
      return oneTask;
    });
    await runCli(home, ["scan"]);

    const first = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider, signal: interrupt.signal });

    expect(first.exitCode).not.toBe(0);
    expect(first.stdout).toContain("Interrupted");
    expect(first.stdout).toContain("1 Session analyzed");
    expect(first.stdout).toMatch(/Used: mock-cheap: 20 input and 40 output tokens/);
    expect(provider.requests()).toHaveLength(2);

    const second = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(second.stdout).toContain("2 Sessions analyzed");
    const resumed = provider.requests().slice(2);
    expect(resumed).toHaveLength(2);
    expect(resumed.join("\n")).not.toContain("cart module");
    expect(resumed.join("\n")).toContain("node version");
    expect(resumed.join("\n")).toContain("update the docs");
  });
});

describe("analyze cost report", () => {
  // The scripted Model Provider reports 10 input and 20 output tokens per request.
  it("reports actual tokens and cost, using the price set in the config", async () => {
    writeSessions("add a checkout button", "fix the flaky test");
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: 1000, outputPerMillion: 2000 } } });
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toMatch(/mock-cheap: about [\d,]+ input and [\d,]+ output tokens, about \$\d+\.\d\d/);
    // (20 × $1000 + 40 × $2000) / 1,000,000 = $0.10
    expect(analyze.stdout).toContain("Used: mock-cheap: 20 input and 40 output tokens, $0.10");
  });

  it.each([
    // [model, input $/M, output $/M] from the providers' official list prices; 10 input and 20 output tokens each.
    ["claude-haiku-5-5", 0.1, 0.5],
    ["gpt-5-mini", 0.25, 2],
    ["gpt-6.1-sol", 2, 10],
    ["o4-mini", 1.1, 4.4],
  ])("knows the list price of %s without any config", async (model, input, output) => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask, { cheap: model, strong: model });
    await runCli(home, ["scan"]);

    const result = (await runCli(home, ["analyze", "--json", "--yes"], { modelProvider: provider.modelProvider })).json();

    expect(result.usage).toEqual([{ model, tokens: { input: 10, output: 20 }, costUsd: (10 * input + 20 * output) / 1_000_000 }]);
  });

  it("prices a dated snapshot like its model, unless the snapshot has its own price", async () => {
    writeSessions("add a checkout button", "fix the flaky test");
    const snapshot = scriptedModelProvider(() => oneTask, { cheap: "gpt-4.1-2025-04-14", strong: "gpt-4.1-2025-04-14" });
    const ownPrice = scriptedModelProvider(() => oneTask, { cheap: "gpt-4o-2024-05-13", strong: "gpt-4o-2024-05-13" });
    await runCli(home, ["scan", "--last", "1"]);

    const first = (await runCli(home, ["analyze", "--json", "--yes"], { modelProvider: snapshot.modelProvider })).json();
    await runCli(home, ["scan"]);
    const second = (await runCli(home, ["analyze", "--json", "--yes"], { modelProvider: ownPrice.modelProvider })).json();

    // gpt-4.1 is $2 / $8; gpt-4o-2024-05-13 is listed at $5 / $15 (gpt-4o itself is $2.50 / $10).
    expect(first.usage[0].costUsd).toBe((10 * 2 + 20 * 8) / 1_000_000);
    expect(second.usage[0].costUsd).toBe((10 * 5 + 20 * 15) / 1_000_000);
  });

  it("reports that the cost is unknown for a model with no known price", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(analyze.stdout).toContain("cost unknown");
    expect(analyze.stdout).toContain("Used: mock-cheap: 10 input and 20 output tokens, cost unknown");
    expect(analyze.stdout).toContain('"prices"');
  });

  it("`--json` reports usage and cost per model", async () => {
    writeSessions("add a checkout button");
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: 1000, outputPerMillion: 2000 } } });
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const result = (await runCli(home, ["analyze", "--json", "--yes"], { modelProvider: provider.modelProvider })).json();

    expect(result.usage).toEqual([{ model: "mock-cheap", tokens: { input: 10, output: 20 }, costUsd: 0.05 }]);
  });

  it("names the problem in an invalid price", async () => {
    writeConfig(home, { prices: { "mock-cheap": { inputPerMillion: "cheap" } } });

    const sessions = await runCli(home, ["sessions"]);

    expect(sessions.exitCode).not.toBe(0);
    expect(sessions.stderr).toContain("prices.mock-cheap");
  });
});

describe("analyze cost estimate", () => {
  it("shows an estimate and spends nothing when the person declines", async () => {
    writeSessions("add a checkout button", "fix the flaky test");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: ["n"] });

    expect(analyze.stdout).toContain("2 Sessions to analyze");
    expect(analyze.stdout).toMatch(/mock-cheap: about [\d,]+ input and [\d,]+ output tokens/);
    expect(analyze.stdout).toContain("Continue?");
    expect(analyze.stdout).toContain("Nothing analyzed");
    expect(analyze.exitCode).toBe(0);
    expect(provider.requests()).toHaveLength(0);
  });

  it("goes ahead after a yes", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: ["y"] });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).toContain("1 Session analyzed");
    expect(provider.requests()).toHaveLength(1);
  });

  it("`--yes` runs without prompting, even with a terminal", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider, answers: [] });

    expect(analyze.exitCode).toBe(0);
    expect(analyze.stdout).not.toContain("Continue?");
    expect(provider.requests()).toHaveLength(1);
  });

  it("without a terminal to ask on, asks for --yes and spends nothing", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);

    const analyze = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider });

    expect(analyze.exitCode).not.toBe(0);
    expect(analyze.stderr).toContain("--yes");
    expect(provider.requests()).toHaveLength(0);
  });

  it("with no new or changed Sessions, neither asks nor calls the Model Provider", async () => {
    writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);
    await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    const again = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: [] });

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("No new or changed Sessions to analyze");
    expect(provider.requests()).toHaveLength(1);
  });

  it("does not analyze a Session again when its file was rewritten without changing what the person typed", async () => {
    const [written] = writeSessions("add a checkout button");
    const provider = scriptedModelProvider(() => oneTask);
    await runCli(home, ["scan"]);
    await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    // Claude Code appends records the person did not type (here a reply), and the file's size and time change.
    appendFileSync(written!.file, "\n");
    utimesSync(written!.file, new Date("2026-05-20T09:00:00.000Z"), new Date("2026-05-20T09:00:00.000Z"));
    const rescan = (await runCli(home, ["scan", "--json"])).json();
    const again = await runCli(home, ["analyze"], { modelProvider: provider.modelProvider, answers: [] });

    expect(rescan.harnesses[0]).toMatchObject({ updated: 1 });
    expect(again.stdout).toContain("No new or changed Sessions to analyze");
    expect(provider.requests()).toHaveLength(1);
    const { sessions } = (await runCli(home, ["tasks", "--json"])).json();
    expect(sessions[0].tasks.map((t: any) => t.title)).toEqual(["Do it"]);
  });

  it("analyzes a Session again when what the person typed changed", async () => {
    const [written] = writeSessions("add a checkout button");
    const provider = scriptedModelProvider((request) => ({
      tasks: [
        {
          title: "Do it",
          messages: [...request.matchAll(/<message index=\\"(\d+)\\">/g)].map(([, i]) => ({ index: Number(i), intent: "New Task" })),
        },
      ],
    }));
    await runCli(home, ["scan"]);
    await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    writeClaudeSession(home, {
      id: written!.id,
      cwd: home.gitRepo("code/shop"),
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [turn.user("add a checkout button"), turn.assistant("Added."), turn.user("now make it blue")],
    });
    await runCli(home, ["scan"]);
    const again = await runCli(home, ["analyze", "--yes"], { modelProvider: provider.modelProvider });

    expect(again.stdout).toContain("1 Session analyzed");
    expect(provider.requests()).toHaveLength(2);
  });
});
