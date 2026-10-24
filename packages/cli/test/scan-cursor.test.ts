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
});
