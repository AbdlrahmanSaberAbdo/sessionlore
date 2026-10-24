import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubble, FixtureHome, writeCursorDatabase } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

describe("scan of Cursor Sessions", () => {
  it("lists Cursor Sessions with Harness, Project, timestamps, model and User Message count", async () => {
    const repo = home.gitRepo("code/shop");
    const {
      composerIds: [id],
    } = writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        model: "claude-sonnet-5-5",
        bubbles: [
          bubble.user("add a checkout button", { wrapped: true }),
          bubble.tool("edit_file_v2"),
          bubble.assistant("Added it."),
          bubble.user("use the shared Button component"),
        ],
      },
    ]);

    expect((await runCli(home, ["scan"])).exitCode).toBe(0);
    const list = await runCli(home, ["sessions", "--json"]);

    expect(list.json()).toEqual({
      sessions: [
        {
          id,
          harness: "cursor",
          project: { name: "shop", path: repo },
          startedAt: "2026-05-01T09:00:00.000Z",
          endedAt: "2026-05-01T09:03:00.000Z",
          model: "claude-sonnet-5-5",
          userMessageCount: 2,
        },
      ],
    });
  });

  it("shows User Messages, assistant messages and tool calls in order", async () => {
    const repo = home.gitRepo("code/shop");
    const {
      composerIds: [id],
    } = writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        bubbles: [
          bubble.user("run the tests", { wrapped: true }),
          bubble.thinking(),
          bubble.tool("run_terminal_command_v2", "completed"),
          bubble.tool("edit_file_v2", "rejected"),
          bubble.assistant("All 3 tests pass."),
          bubble.user("thanks"),
        ],
      },
    ]);

    await runCli(home, ["scan"]);
    const shown = await runCli(home, ["session", id!, "--json"]);

    expect(shown.exitCode).toBe(0);
    expect(shown.json().session.messages).toEqual([
      { role: "user", text: "run the tests", timestamp: "2026-05-01T09:00:00.000Z" },
      { role: "tool", name: "run_terminal_command_v2", status: "completed", timestamp: "2026-05-01T09:02:00.000Z" },
      { role: "tool", name: "edit_file_v2", status: "rejected", timestamp: "2026-05-01T09:03:00.000Z" },
      { role: "assistant", text: "All 3 tests pass.", timestamp: "2026-05-01T09:04:00.000Z" },
      { role: "user", text: "thanks", timestamp: "2026-05-01T09:05:00.000Z" },
    ]);
  });

  it("attaches a subagent composer to its parent Session instead of listing it", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      {
        id: "parent-composer",
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        stepSeconds: 60,
        bubbles: [
          bubble.user("find where prices are rounded"),
          bubble.tool("task_v2", "completed", { toolCallId: "call-explore" }),
          bubble.assistant("Prices are rounded in money.ts."),
        ],
      },
      {
        id: "subagent-composer",
        folder: repo,
        createdAt: "2026-05-01T09:01:10.000Z",
        stepSeconds: 5,
        subagentOf: { parentId: "parent-composer", toolCallId: "call-explore", typeName: "explore" },
        bubbles: [
          bubble.user("Search the codebase for price rounding."),
          bubble.tool("ripgrep_raw_search"),
          bubble.assistant("Found Math.round in money.ts."),
        ],
      },
    ]);

    await runCli(home, ["scan"]);
    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    const { session } = (await runCli(home, ["session", "parent-composer", "--json"])).json();

    expect(sessions.map((s: any) => [s.id, s.userMessageCount])).toEqual([["parent-composer", 1]]);
    expect(session.messages.map((m: any) => m.name ?? m.text)).toEqual([
      "find where prices are rounded",
      "task_v2",
      "Search the codebase for price rounding.",
      "ripgrep_raw_search",
      "Found Math.round in money.ts.",
      "Prices are rounded in money.ts.",
    ]);
    expect(session.messages[2]).toMatchObject({ role: "assistant", subagent: "explore" });
  });
});
