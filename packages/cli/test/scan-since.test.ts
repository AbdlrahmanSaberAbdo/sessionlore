import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { fixedClock, runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const now = fixedClock("2026-06-01T12:00:00.000Z");

async function scanAndList(args: string[]): Promise<string[]> {
  const scan = await runCli(home, ["scan", ...args], { clock: now });
  expect(scan.exitCode, scan.stderr).toBe(0);
  return (await runCli(home, ["sessions", "--json"])).json().sessions.map((s: { startedAt: string }) => s.startedAt.slice(0, 10));
}

function sessionsOn(...days: string[]) {
  const repo = home.gitRepo("code/shop");
  for (const day of days) writeClaudeSession(home, { cwd: repo, startedAt: `${day}T09:00:00.000Z`, turns: [turn.user(day)] });
}

describe("scan --since", () => {
  it("stores only Sessions active within the last N days", async () => {
    sessionsOn("2026-04-01", "2026-05-10", "2026-05-30");

    expect(await scanAndList(["--since", "30d"])).toEqual(["2026-05-30", "2026-05-10"]);
  });

  it("takes weeks", async () => {
    sessionsOn("2026-05-10", "2026-05-20", "2026-05-30");

    expect(await scanAndList(["--since", "2w"])).toEqual(["2026-05-30", "2026-05-20"]);
  });

  it("takes a date and keeps Sessions active on or after it", async () => {
    sessionsOn("2026-04-30", "2026-05-01", "2026-05-30");

    expect(await scanAndList(["--since", "2026-05-01"])).toEqual(["2026-05-30", "2026-05-01"]);
  });

  it("combines with --last, keeping the most recent of the Sessions in the window", async () => {
    sessionsOn("2026-04-01", "2026-05-10", "2026-05-20", "2026-05-30");

    expect(await scanAndList(["--since", "30d", "--last", "2"])).toEqual(["2026-05-30", "2026-05-20"]);
  });

  it("combines with --harness", async () => {
    sessionsOn("2026-04-01", "2026-05-30");

    expect(await scanAndList(["--since", "30d", "--harness", "claude-code"])).toEqual(["2026-05-30"]);
  });

  it("rejects a window it can't read, saying what it takes", async () => {
    for (const bad of ["30", "thirty days", "3m", "0d", "2026-13-01", "2026-02-30"]) {
      const result = await runCli(home, ["scan", "--since", bad], { clock: now });

      expect(result.exitCode, bad).toBe(2);
      expect(result.stderr).toContain(`--since takes a number of days or weeks (30d, 2w) or a date (2026-09-01), not "${bad}"`);
    }
  });
});
