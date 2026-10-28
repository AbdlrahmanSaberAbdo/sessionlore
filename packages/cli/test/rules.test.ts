import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@habitlore/fixtures";
import { topicEmbedder } from "./support/embedder.js";
import { fixedClock, runCli, type RunOptions } from "./support/harness.js";
import { scriptedModelProvider } from "./support/model-provider.js";

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

const pnpmRule = { title: "Use pnpm", rule: "Use pnpm, never npm, to install packages and run scripts." };

/**
 * Labels User Messages by how they start: "no, ..." is a Correction in the
 * Task before it, anything else starts a New Task titled with its text. Names
 * every Cluster after its first topic, and writes `rule` for any Correction
 * Cluster it is asked about.
 */
function modelProvider(rule: (request: string) => object = () => pnpmRule) {
  return scriptedModelProvider((request) => {
    if (request.includes("<correction-cluster")) return rule(request);
    if (request.includes("<workflow")) return { title: "Some skill", trigger: "Use when.", steps: ["Do it."] };
    const messages = [...request.matchAll(/<message index=\\"(\d+)\\">\\n([\s\S]*?)\\n<\/message>/g)];
    if (messages.length === 0) {
      return { name: request.includes("pnpm") ? "Use pnpm, not npm" : request.includes("tabs") ? "Indent with tabs" : "Other" };
    }
    const tasks: { title: string; messages: { index: number; intent: string }[] }[] = [];
    for (const [, index, text] of messages) {
      const intent = text!.startsWith("no,") ? "Correction" : "New Task";
      if (intent === "New Task" || tasks.length === 0) tasks.push({ title: text!, messages: [] });
      tasks.at(-1)!.messages.push({ index: Number(index), intent });
    }
    return { tasks };
  });
}

const now = fixedClock("2026-06-01T12:00:00.000Z");

function options(provider = modelProvider()): RunOptions & { requests(): string[] } {
  return {
    modelProvider: provider.modelProvider,
    embedder: topicEmbedder(["pnpm", "tabs", "database migration", "release notes"]),
    clock: now,
    requests: provider.requests,
  };
}

function session(cwd: string, startedAt: string, ...messages: string[]) {
  return writeClaudeSession(home, {
    cwd,
    startedAt,
    turns: messages.flatMap((m) => [turn.user(m), turn.assistant("Done.")]),
  });
}

async function analyze(opts: RunOptions) {
  expect((await runCli(home, ["scan"], opts)).exitCode).toBe(0);
  const analysis = await runCli(home, ["analyze", "--json", "--yes"], opts);
  expect(analysis.exitCode, analysis.stderr).toBe(0);
  expect(analysis.json().failed).toEqual([]);
}

async function suggest(opts: RunOptions) {
  const result = await runCli(home, ["suggest", "--json", "--yes"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json();
}

async function review(opts: RunOptions = {}) {
  const result = await runCli(home, ["review", "--json"], opts);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.json().suggestions;
}

/** Three "use pnpm" Corrections across three Sessions in `shop`: a qualifying Correction Cluster, and no Workflow. */
function pnpmCorrectionsIn(cwd: string) {
  return [
    session(cwd, "2026-05-10T09:00:00.000Z", "write a database migration for orders", "no, use pnpm not npm to run it"),
    session(cwd, "2026-05-20T09:00:00.000Z", "update the release notes", "no, we use pnpm here"),
    session(cwd, "2026-05-25T09:00:00.000Z", "fix the build", "no, pnpm please"),
  ];
}

describe("suggest Rules", () => {
  it("writes one Pending Rule Suggestion per qualifying Correction Cluster, with the Corrections as Evidence", async () => {
    const shop = home.gitRepo("code/shop");
    const sessions = pnpmCorrectionsIn(shop);
    // Two Corrections about tabs: a near Correction Cluster, which earns no Rule.
    session(shop, "2026-05-26T09:00:00.000Z", "format the file", "no, indent with tabs");
    session(shop, "2026-05-27T09:00:00.000Z", "add a helper", "no, tabs not spaces");
    const opts = options();
    await analyze(opts);

    const result = await suggest(opts);

    expect(result.created).toHaveLength(1);
    const strongRequests = opts.requests().filter((r) => r.includes("<correction-cluster"));
    expect(strongRequests).toHaveLength(1);
    expect(strongRequests[0]).toContain("no, we use pnpm here");
    expect(strongRequests[0]).not.toContain("tabs");

    const [suggestion, ...others] = await review();
    expect(others).toEqual([]);
    expect(suggestion).toMatchObject({
      id: result.created[0],
      kind: "rule",
      state: "Pending",
      title: "Use pnpm",
      rule: "Use pnpm, never npm, to install packages and run scripts.",
      correctionCluster: { name: "Use pnpm, not npm" },
      scope: { kind: "project", project: { name: "shop", path: shop } },
    });
    const project = { name: "shop", path: shop };
    expect(suggestion.evidence).toEqual([
      {
        correction: { text: "no, use pnpm not npm to run it", at: expect.any(String) },
        task: { title: "write a database migration for orders", at: "2026-05-10T09:00:00.000Z" },
        session: { id: sessions[0]!.id, harness: "claude-code" },
        project,
      },
      {
        correction: { text: "no, we use pnpm here", at: expect.any(String) },
        task: { title: "update the release notes", at: "2026-05-20T09:00:00.000Z" },
        session: { id: sessions[1]!.id, harness: "claude-code" },
        project,
      },
      {
        correction: { text: "no, pnpm please", at: expect.any(String) },
        task: { title: "fix the build", at: "2026-05-25T09:00:00.000Z" },
        session: { id: sessions[2]!.id, harness: "claude-code" },
        project,
      },
    ]);
  });

  it("does not write another Rule for a Correction Cluster whose Rule was Rejected, even as it grows", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrectionsIn(shop);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect((await runCli(home, ["reject", String(id)], opts)).exitCode).toBe(0);

    session(shop, "2026-05-28T09:00:00.000Z", "bump the deps", "no, run pnpm install");
    await analyze(opts);

    expect((await suggest(opts)).created).toEqual([]);
    expect(opts.requests().filter((r) => r.includes("<correction-cluster"))).toHaveLength(1);
    expect(existsSync(join(shop, "CLAUDE.md"))).toBe(false);
  });

  it("keeps a Rule with its Correction Cluster through a recluster, so it isn't proposed again", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrectionsIn(shop);
    session(shop, "2026-05-26T09:00:00.000Z", "add a helper", "no, not yarn");
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    const pnpm = (await runCli(home, ["corrections", "--json"], opts)).json().correctionClusters[0];

    const together = { ...opts, embedder: topicEmbedder(["no, "], "embedder-together") };
    const reclustered = await runCli(home, ["recluster", "--json", "--yes"], together);
    expect(reclustered.exitCode, reclustered.stderr).toBe(0);

    const [rule] = await review();
    expect(rule).toMatchObject({ id, correctionCluster: { id: pnpm.id } });
    expect((await suggest(together)).created).toEqual([]);
  });
});

describe("accept a Rule", () => {
  it("creates the Project's CLAUDE.md with a section habitlore manages, holding the Rule", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrectionsIn(shop);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect(existsSync(join(shop, "CLAUDE.md"))).toBe(false);

    const result = await runCli(home, ["accept", String(id), "--json"], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    const file = join(shop, "CLAUDE.md");
    expect(result.json()).toMatchObject({ suggestion: { id, state: "Accepted" }, files: [{ path: file }] });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "<!-- habitlore:rules:start -->",
        "## Rules from habitlore",
        "",
        "- Use pnpm, never npm, to install packages and run scripts.",
        "<!-- habitlore:rules:end -->",
        "",
      ].join("\n"),
    );
    expect(existsSync(home.resolve(".claude/CLAUDE.md"))).toBe(false);
  });

  it("adds a User scope Rule to the user-level CLAUDE.md, leaving what the person wrote untouched", async () => {
    session(home.gitRepo("code/shop"), "2026-05-10T09:00:00.000Z", "fix the build", "no, use pnpm not npm");
    session(home.gitRepo("code/blog"), "2026-05-20T09:00:00.000Z", "add a post", "no, we use pnpm here", "no, pnpm please");
    const mine = "# My preferences\r\n\r\nKeep answers short.  \n<!-- a comment -->";
    const file = home.resolve(".claude/CLAUDE.md");
    mkdirSync(home.resolve(".claude"), { recursive: true });
    writeFileSync(file, mine);
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;
    expect((await review())[0].scope).toEqual({ kind: "user" });

    const result = await runCli(home, ["accept", String(id)], opts);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(file);
    const content = readFileSync(file, "utf8");
    expect(content.startsWith(mine)).toBe(true);
    expect(content.slice(mine.length)).toBe(
      [
        "",
        "",
        "<!-- habitlore:rules:start -->",
        "## Rules from habitlore",
        "",
        "- Use pnpm, never npm, to install packages and run scripts.",
        "<!-- habitlore:rules:end -->",
        "",
      ].join("\n"),
    );
  });

  it("adds a second Rule to the same managed section, keeping content before and after it", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrectionsIn(shop);
    session(shop, "2026-05-26T09:00:00.000Z", "format the file", "no, indent with tabs");
    session(shop, "2026-05-27T09:00:00.000Z", "add a helper", "no, tabs not spaces", "no, tabs please");
    const file = join(shop, "CLAUDE.md");
    writeFileSync(file, "# Shop\n\nRun tests with `make test`.\n");
    const opts = options(
      modelProvider((request) =>
        request.includes("tabs") ? { title: "Indent with tabs", rule: "Indent with tabs, not spaces." } : pnpmRule,
      ),
    );
    await analyze(opts);
    const created = (await suggest(opts)).created;
    expect(created).toHaveLength(2);
    const byTitle = new Map((await review()).map((s: any) => [s.title, s.id]));

    expect((await runCli(home, ["accept", String(byTitle.get("Use pnpm"))], opts)).exitCode).toBe(0);
    // The person writes more after habitlore's section.
    writeFileSync(file, readFileSync(file, "utf8") + "\n## Notes\n\nDeploys are on Fridays.\n");
    const second = await runCli(home, ["accept", String(byTitle.get("Indent with tabs"))], opts);

    expect(second.exitCode, second.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      [
        "# Shop",
        "",
        "Run tests with `make test`.",
        "",
        "<!-- habitlore:rules:start -->",
        "## Rules from habitlore",
        "",
        "- Use pnpm, never npm, to install packages and run scripts.",
        "- Indent with tabs, not spaces.",
        "<!-- habitlore:rules:end -->",
        "",
        "## Notes",
        "",
        "Deploys are on Fridays.",
        "",
      ].join("\n"),
    );
  });
});

describe("editing, re-scoping and suggesting Rules again", () => {
  it("edits a Rule's text, and changes its Scope to User scope", async () => {
    pnpmCorrectionsIn(home.gitRepo("code/shop"));
    const opts = options();
    await analyze(opts);
    const [id] = (await suggest(opts)).created;

    const edited = await runCli(home, ["edit", String(id)], {
      ...opts,
      editor: (text) => {
        expect(JSON.parse(text)).toEqual(pnpmRule);
        return JSON.stringify({ title: "pnpm only", rule: "Always use pnpm." });
      },
    });
    const scoped = await runCli(home, ["scope", String(id), "user"], opts);

    expect(edited.exitCode, edited.stderr).toBe(0);
    expect(scoped.exitCode, scoped.stderr).toBe(0);
    expect((await review())[0]).toMatchObject({ id, title: "pnpm only", rule: "Always use pnpm.", scope: { kind: "user" } });
  });

  it("writes no new Rule for an unchanged Correction Cluster, and replaces a Pending one after several new Corrections", async () => {
    const shop = home.gitRepo("code/shop");
    pnpmCorrectionsIn(shop);
    let rule: object = pnpmRule;
    const opts = options(modelProvider(() => rule));
    await analyze(opts);
    const [first] = (await suggest(opts)).created;
    expect(await suggest(opts)).toMatchObject({ created: [], replaced: [] });

    session(shop, "2026-05-27T09:00:00.000Z", "add a script", "no, pnpm run it");
    session(shop, "2026-05-28T09:00:00.000Z", "add a dependency", "no, install it with pnpm");
    await analyze(opts);
    rule = { title: "Use pnpm", rule: "Use pnpm for every install and script." };
    const again = await suggest(opts);

    expect(again.replaced).toEqual([first]);
    const [suggestion, ...others] = await review();
    expect(others).toEqual([]);
    expect(suggestion).toMatchObject({ id: again.created[0], rule: "Use pnpm for every install and script." });
    expect(suggestion.evidence).toHaveLength(5);
  });
});
