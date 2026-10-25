import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

async function scanAndList(args: string[] = []): Promise<any[]> {
  const scan = await runCli(home, ["scan", ...args]);
  expect(scan.exitCode).toBe(0);
  return (await runCli(home, ["sessions", "--json"])).json().sessions;
}

describe("scan of Claude Code Sessions: the tricky cases", () => {
  it("merges assistant records that share one message id and counts their token usage once", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("explain the checkout flow"),
        turn.splitAssistant(["Let me think.", "It goes cart, address, payment.", "Anything else?"], {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 1000,
        }),
      ],
    });

    const [session] = await scanAndList();

    expect(session.assistantTurnCount).toBe(1);
    expect(session.tokens).toEqual({ input: 100, output: 50, cacheCreation: 200, cacheRead: 1000 });
  });

  it("attaches a subagent transcript to its parent Session without counting the subagent's prompts", async () => {
    const repo = home.gitRepo("code/shop");
    const parent = writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("find where prices are rounded"),
        turn.subagent({
          description: "Search for rounding",
          prompt: "Find every place prices are rounded and report file paths.",
          turns: [
            turn.tool("Grep", { pattern: "round" }, "src/price.ts"),
            turn.user("Also check the tests folder."),
            turn.assistant("Rounding happens in src/price.ts.", { input_tokens: 7, output_tokens: 3 }),
          ],
          result: "Rounding happens in src/price.ts.",
        }),
        turn.assistant("Prices are rounded in src/price.ts."),
      ],
    });

    const sessions = await scanAndList();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: parent.id,
      userMessageCount: 1,
      subagentRunCount: 1,
      // Parent: the Agent tool call and the final reply (10/20 each). Subagent: Grep call (10/20) and reply (7/3).
      tokens: { input: 37, output: 63 },
    });
  });

  it("excludes command wrappers, meta records and other Harness-written text from User Messages", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.command("review"),
        turn.meta("Base directory for this skill: /home/me/.claude/skills/review\n\nReview the file."),
        turn.assistant("The cart looks fine."),
        turn.user("<system-reminder>The user opened src/cart.ts</system-reminder>\nwhy is the total off by a cent?"),
        turn.assistant("Rounding."),
        turn.interrupted(),
        turn.command("cost"),
        turn.localCommandOutput("Total cost: $0.42"),
        turn.taskNotification("Background build finished"),
        turn.user("<system-reminder>Reminder: todo list is empty.</system-reminder>"),
      ],
    });

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();

    expect(sessions[0].userMessageCount).toBe(1);
  });

  it("keeps the text typed after a slash command as a User Message, without the command's name or wrapper", async () => {
    const written = writeClaudeSession(home, {
      cwd: home.gitRepo("code/shop"),
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.command("review", "check the rounding in src/cart.ts"),
        turn.assistant("The cart looks fine."),
        turn.command("compact"),
        turn.user("thanks"),
      ],
    });

    await runCli(home, ["scan"]);
    const shown = (await runCli(home, ["session", written.id, "--json"])).json().session;

    expect(shown.userMessageCount).toBe(2);
    expect(shown.messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual([
      "check the rounding in src/cart.ts",
      "thanks",
    ]);
  });

  it("follows the message tree, leaving out branches the conversation abandoned", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("rename the cart module"),
        turn.assistant("Renamed it to basket."),
        // The person edited their next message, so this branch was left behind.
        turn.abandoned([turn.user("now delete the old tests"), turn.assistant("Deleted them.")]),
        turn.user("now update the imports"),
        turn.assistant("Updated the imports."),
      ],
    });

    const [session] = await scanAndList();

    expect(session).toMatchObject({ userMessageCount: 2, assistantTurnCount: 2 });
  });

  it("shows User Messages, assistant replies and tool calls of the active branch in order", async () => {
    const written = writeClaudeSession(home, {
      cwd: home.gitRepo("code/shop"),
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("run the tests"),
        turn.tool("Bash", { command: "pnpm test" }, "3 passed"),
        turn.splitAssistant(["All 3 tests pass.", "Anything else?"]),
        turn.meta("Caveat: injected by the Harness."),
        turn.abandoned([turn.user("delete the tests"), turn.assistant("Deleted them.")]),
        turn.user("thanks"),
      ],
    });

    await runCli(home, ["scan"]);
    const shown = await runCli(home, ["session", written.id, "--json"]);

    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.json().session.messages.map((m: any) => [m.role, m.text ?? m.name, m.status])).toEqual([
      ["user", "run the tests", undefined],
      ["tool", "Bash", "completed"],
      ["assistant", "All 3 tests pass.\n\nAnything else?", undefined],
      ["user", "thanks", undefined],
    ]);
  });
});

describe("unknown storage shapes", () => {
  it("completes the Scan and warns with the count of records it did not recognise", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("add a checkout button"),
        turn.record({ type: "hologram", frames: 3 }),
        turn.assistant("Added it."),
        turn.record({ type: "hologram", frames: 1 }),
        turn.record({ type: "summary", summary: "Checkout button" }),
      ],
    });

    const scan = await runCli(home, ["scan", "--json"]);

    expect(scan.exitCode).toBe(0);
    expect(scan.json().harnesses[0]).toMatchObject({ added: 1 });
    expect(scan.stderr).toMatch(/Claude Code.*2 records.*not recognise/);
    expect(scan.stderr).toContain('"hologram"');
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    expect(sessions[0].userMessageCount).toBe(1);
  });

  it("does not warn when every record is one Claude Code is known to write", async () => {
    const repo = home.gitRepo("code/shop");
    writeClaudeSession(home, {
      cwd: repo,
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.record({ type: "file-history-snapshot", snapshot: {} }),
        turn.user("hi"),
        turn.record({ type: "system", subtype: "turn_duration", durationMs: 1200 }),
        turn.record({ type: "attachment", attachment: { type: "date" } }),
      ],
    });

    const scan = await runCli(home, ["scan"]);

    expect(scan.exitCode).toBe(0);
    expect(scan.stderr).toBe("");
  });
});

describe("scan --last N", () => {
  it("stores only the N most recent Sessions", async () => {
    const repo = home.gitRepo("code/shop");
    const days = ["01", "02", "03", "04", "05", "06", "07"];
    // Written out of date order, so recency can't come from the order files are found in.
    for (const day of ["04", "01", "07", "02", "06", "03", "05"]) {
      writeClaudeSession(home, { cwd: repo, startedAt: `2026-05-${day}T09:00:00.000Z`, turns: [turn.user(day)] });
    }

    const sessions = await scanAndList(["--last", "5"]);

    expect(sessions.map((s) => s.startedAt)).toEqual(
      days.slice(2).reverse().map((day) => `2026-05-${day}T09:00:00.000Z`),
    );
  });

  it("rejects a count that is not a positive whole number", async () => {
    const result = await runCli(home, ["scan", "--last", "five"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--last");
  });
});

describe("incremental scan", () => {
  it("only re-reads Sessions that changed since the last Scan", async () => {
    const repo = home.gitRepo("code/shop");
    const first = { cwd: repo, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user("one")] };
    const written = writeClaudeSession(home, first);
    writeClaudeSession(home, { cwd: repo, startedAt: "2026-05-02T09:00:00.000Z", turns: [turn.user("two")] });

    expect((await runCli(home, ["scan", "--json"])).json().harnesses[0]).toMatchObject({ added: 2, updated: 0 });

    const unchanged = await runCli(home, ["scan", "--json"]);
    expect(unchanged.json().harnesses[0]).toMatchObject({ added: 0, updated: 0, unchanged: 2 });

    // The person came back to the first Session and kept going.
    writeClaudeSession(home, {
      ...first,
      id: written.id,
      turns: [...first.turns, turn.assistant("Done."), turn.user("and three")],
    });
    const changed = await runCli(home, ["scan"]);
    expect(changed.stdout).toContain("Claude Code: 0 Sessions added, 1 updated, 1 unchanged");

    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    expect(sessions.find((s: any) => s.id === written.id).userMessageCount).toBe(2);
  });

  it("re-reads a Session when one of its subagent transcripts changes", async () => {
    const repo = home.gitRepo("code/shop");
    const spec = (result: string) => ({
      cwd: repo,
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-05-01T09:00:00.000Z",
      turns: [
        turn.user("look around"),
        turn.subagent({ description: "Explore", prompt: "Explore the repo.", turns: [turn.assistant(result)], result }),
      ],
    });
    writeClaudeSession(home, spec("short"));
    await runCli(home, ["scan"]);

    writeClaudeSession(home, spec("a much longer subagent answer"));
    const again = await runCli(home, ["scan", "--json"]);

    expect(again.json().harnesses[0]).toMatchObject({ added: 0, updated: 1 });
  });
});
