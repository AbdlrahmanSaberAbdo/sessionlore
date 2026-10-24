import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli, writeConfig } from "./support/harness.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

function sessionIn(cwd: string, text = "hi"): string {
  return writeClaudeSession(home, { cwd, startedAt: "2026-05-01T09:00:00.000Z", turns: [turn.user(text)] }).id;
}

async function listedProjects(): Promise<string[]> {
  const { sessions } = (await runCli(home, ["sessions", "--json"])).json();
  return sessions.map((s: any) => s.project?.name ?? null).sort();
}

describe("excluding Projects in the config", () => {
  it("stores no Sessions of a Project excluded by name", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.gitRepo("code/secret-client"));
    writeConfig(home, { projects: { exclude: ["secret-client"] } });

    const scan = await runCli(home, ["scan", "--json"]);

    expect(scan.exitCode).toBe(0);
    expect(scan.json().harnesses[0].added).toBe(1);
    expect(await listedProjects()).toEqual(["shop"]);
  });

  it("stores no Sessions of Projects matching an excluded path glob", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.gitRepo("clients/acme/portal"));
    sessionIn(home.folder("clients/globex"));
    writeConfig(home, { projects: { exclude: ["~/clients/**"] } });

    await runCli(home, ["scan"]);

    expect(await listedProjects()).toEqual(["shop"]);
  });

  it("matches a path glob against the Project, so worktrees and subfolders of an excluded repository are excluded too", async () => {
    const repo = home.gitRepo("code/secret");
    sessionIn(home.gitWorktree(repo, "elsewhere/secret-feature"));
    sessionIn(home.folder("code/secret/packages/api"));
    sessionIn(home.gitRepo("code/shop"));
    writeConfig(home, { projects: { exclude: [repo] } });

    await runCli(home, ["scan"]);

    expect(await listedProjects()).toEqual(["shop"]);
  });
});

describe("including only some Projects in the config", () => {
  it("stores only Sessions of the listed Projects", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.gitRepo("code/blog"));
    sessionIn(home.gitRepo("work/api"));
    sessionIn(home.folder("scratch"));
    writeConfig(home, { projects: { include: ["shop", "~/work/*"] } });

    await runCli(home, ["scan"]);

    expect(await listedProjects()).toEqual(["api", "shop"]);
  });

  it("still leaves out excluded Projects that the include list covers", async () => {
    sessionIn(home.gitRepo("work/api"));
    sessionIn(home.gitRepo("work/payroll"));
    writeConfig(home, { projects: { include: ["~/work/**"], exclude: ["payroll"] } });

    await runCli(home, ["scan"]);

    expect(await listedProjects()).toEqual(["api"]);
  });
});

describe("changing the config after a Scan", () => {
  // Each test drops the config again before listing, so it sees what the store holds.
  it("removes Sessions of a newly excluded Project from the store on the next Scan", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.gitRepo("code/secret"));
    await runCli(home, ["scan"]);
    expect(await listedProjects()).toEqual(["secret", "shop"]);

    writeConfig(home, { projects: { exclude: ["secret"] } });
    expect((await runCli(home, ["scan"])).exitCode).toBe(0);

    writeConfig(home, {});
    expect(await listedProjects()).toEqual(["shop"]);
  });

  it("hides a newly excluded Project from `sessions` even before the next Scan", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.gitRepo("code/secret"));
    await runCli(home, ["scan"]);

    writeConfig(home, { projects: { exclude: ["secret"] } });

    expect(await listedProjects()).toEqual(["shop"]);
  });

  it("removes Sessions outside a newly set include list on the next Scan", async () => {
    sessionIn(home.gitRepo("code/shop"));
    sessionIn(home.folder("scratch"));
    await runCli(home, ["scan"]);

    writeConfig(home, { projects: { include: ["shop"] } });
    await runCli(home, ["scan"]);

    writeConfig(home, {});
    expect(await listedProjects()).toEqual(["shop"]);
  });
});
