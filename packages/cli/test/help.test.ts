import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome } from "@habitlore/fixtures";
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
      expect(result.stdout).toContain("Usage: habitlore <command>");
    }
  });

  it("prints the usage as an error for an unknown command", async () => {
    const result = await runCli(home, ["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage: habitlore <command>");
  });

  it("names a bad option value with a pointer to --help instead of the whole usage", async () => {
    for (const args of [["scan", "--since", "30x"], ["scan", "--last", "0"], ["scan", "--harness", "vim"], ["serve", "--port", "99999"]]) {
      const result = await runCli(home, args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`"${args[2]}"`);
      expect(result.stderr).toContain("habitlore --help");
      expect(result.stderr).not.toContain("Usage: habitlore <command>");
    }
  });
});
