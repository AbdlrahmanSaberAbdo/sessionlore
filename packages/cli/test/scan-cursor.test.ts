import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bubble, cursorDatabasePath, FixtureHome, holdCursorDatabaseOpen, writeCursorDatabase } from "@sessionlore/fixtures";
import { snapshotTree } from "./support/files.js";
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

  it("leaves the Cursor database unchanged", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("hi"), bubble.assistant("hello")] },
    ]);
    const before = snapshotTree(dirname(cursorDatabasePath(home)));

    expect((await runCli(home, ["scan"])).exitCode).toBe(0);

    expect(snapshotTree(dirname(cursorDatabasePath(home)))).toEqual(before);
  });

  it("scans while Cursor holds the database open", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("hi"), bubble.assistant("hello")] },
    ]);
    const cursor = holdCursorDatabaseOpen(home);
    try {
      const scan = await runCli(home, ["scan"]);
      expect(scan.stderr).toBe("");
      expect(scan.exitCode).toBe(0);
    } finally {
      cursor.close();
    }

    const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
    expect(sessions).toHaveLength(1);
  });

  it("reports zero updated Cursor Sessions when nothing changed, and one when a Session changed", async () => {
    const repo = home.gitRepo("code/shop");
    const composers = [
      { id: "first", folder: repo, createdAt: "2026-05-01T09:00:00.000Z", bubbles: [bubble.user("one")] },
      { id: "second", folder: repo, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("two")] },
    ];
    writeCursorDatabase(home, composers);

    const first = (await runCli(home, ["scan", "--json"])).json();
    const second = (await runCli(home, ["scan", "--json"])).json();
    writeCursorDatabase(home, [composers[0]!, { ...composers[1]!, bubbles: [bubble.user("two"), bubble.user("and more")] }]);
    const third = (await runCli(home, ["scan", "--json"])).json();

    expect(first.harnesses).toEqual([{ harness: "cursor", name: "Cursor", added: 2, updated: 0, warnings: [] }]);
    expect(second.harnesses).toEqual([{ harness: "cursor", name: "Cursor", added: 0, updated: 0, warnings: [] }]);
    expect(third.harnesses).toEqual([{ harness: "cursor", name: "Cursor", added: 0, updated: 1, warnings: [] }]);
  });

  it("warns with a count about bubbles in an unknown format version, without crashing or dropping them silently", async () => {
    const repo = home.gitRepo("code/shop");
    writeCursorDatabase(home, [
      {
        folder: repo,
        createdAt: "2026-05-01T09:00:00.000Z",
        bubbles: [
          bubble.user("hi"),
          bubble.assistant("hello", { version: 99 }),
          bubble.user("more", { version: 99 }),
        ],
      },
    ]);

    const text = await runCli(home, ["scan"]);
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toMatch(/Cursor.*2 .*unknown format version 99/i);

    writeCursorDatabase(home, [
      { folder: repo, createdAt: "2026-05-02T09:00:00.000Z", bubbles: [bubble.user("again", { version: 99 })] },
    ]);
    const json = (await runCli(home, ["scan", "--json"])).json();
    expect(json.harnesses[0].warnings).toEqual([
      { message: expect.stringMatching(/unknown format version 99/), count: 1 },
    ]);
  });
});
