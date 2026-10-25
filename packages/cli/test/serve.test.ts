import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureHome, turn, writeClaudeSession } from "@sessionlore/fixtures";
import { runCli } from "./support/harness.js";

/** These tests run real servers (and the demo a full scripted Analysis), so they get more than the default 5s. */
const SLOW = 30_000;

let home: FixtureHome;

beforeEach(() => {
  home = FixtureHome.create();
});

afterEach(() => {
  home.remove();
});

/** Starts `serve`, waits until it opens the browser, and returns the URL it opened plus a way to stop it. */
async function startServe(args: string[] = []) {
  const stop = new AbortController();
  let opened!: (url: string) => void;
  const browserUrl = new Promise<string>((resolve) => (opened = resolve));
  const run = runCli(home, ["serve", "--port", "0", ...args], { signal: stop.signal, openBrowser: opened });
  const url = await Promise.race([browserUrl, run.then((r) => Promise.reject(new Error(`serve exited early: ${r.stderr}`)))]);
  return { url, stop: async () => (stop.abort(), run) };
}

describe("serve", { timeout: SLOW }, () => {
  it("serves the dashboard on localhost only, opens the browser on it, and stops cleanly when interrupted", async () => {
    writeClaudeSession(home, { cwd: home.gitRepo("code/shop"), startedAt: "2026-05-04T09:00:00.000Z", turns: [turn.user("hi")] });
    expect((await runCli(home, ["scan"])).exitCode).toBe(0);

    const serve = await startServe();
    const url = new URL(serve.url);
    const overview = await (await fetch(new URL("/api/overview", url))).json();
    const result = await serve.stop();

    expect(url.hostname).toBe("127.0.0.1");
    expect(overview.counts.sessions).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(serve.url);
    await expect(fetch(new URL("/api/overview", url))).rejects.toThrow();
  });

  it("only prints the address with --no-open", async () => {
    const stop = new AbortController();
    const openBrowser = (url: string) => {
      throw new Error(`opened ${url}`);
    };
    // Interrupted at once: serve still starts and prints its address before it stops.
    stop.abort();
    const result = await runCli(home, ["serve", "--port", "0", "--no-open"], { signal: stop.signal, openBrowser });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\//);
  });

  it("rejects a port that is not a number", async () => {
    const result = await runCli(home, ["serve", "--port", "eighty"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--port");
  });
});
