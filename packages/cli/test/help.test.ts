import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

describe("help", () => {
  it("prints the usage and succeeds when asked for with --help", async () => {
    for (const args of [["--help"], ["-h"], ["scan", "--help"]]) {
      const result = await runCli(home, args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: sessionlore <command>");
    }
  });

  it("prints the usage as an error for an unknown command", async () => {
    const result = await runCli(home, ["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage: sessionlore <command>");
  });
});
