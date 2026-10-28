import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The published `habitlore` package, as `npm pack` would build it: one
 * self-contained package with the CLI, server and dashboard UI, and nothing
 * from the workspace's sources, tests or local machine.
 */

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface PackedFile {
  path: string;
}

let files: string[];
let manifest: {
  version: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
  exports?: unknown;
  repository?: unknown;
  license?: string;
};

beforeAll(() => {
  // Always built afresh: a dist left by an interrupted or earlier build may be half-written or stale.
  // NODE_ENV is set explicitly because vitest sets it to "test", which would make Vite build the UI in development mode.
  execFileSync("corepack", ["pnpm", "build"], { cwd: repoRoot, stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } });
  for (const built of ["dist/bin.js", "dist/ui/index.html"]) {
    if (!existsSync(`${packageDir}/${built}`)) throw new Error(`The build did not produce ${built}`);
  }
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageDir, encoding: "utf8" }),
  ) as [{ files: PackedFile[] }];
  files = packed.files.map((f) => f.path).sort();
  manifest = JSON.parse(readFileSync(`${packageDir}/package.json`, "utf8"));
}, 180_000);

describe("the published package", () => {
  it("contains the CLI, the built dashboard UI, the README and the license", () => {
    expect(files).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "dist/bin.js", "dist/ui/index.html"]));
    expect(manifest.bin).toEqual({ habitlore: "./dist/bin.js" });
  });

  it("contains only built files: no sources, tests, source maps or session data", () => {
    const unexpected = files.filter(
      (path) => !["package.json", "README.md", "LICENSE"].includes(path) && !path.startsWith("dist/"),
    );
    expect(unexpected).toEqual([]);
    expect(files.filter((path) => /\.(map|ts|tsx|jsonl|sqlite|db|vscdb)$/.test(path))).toEqual([]);
  });

  it("does not leak paths from the machine it was built on", () => {
    const leaking = files
      .filter((path) => path.startsWith("dist/"))
      .filter((path) => readFileSync(`${packageDir}/${path}`, "utf8").includes(repoRoot.replace(/\/$/, "")));
    expect(leaking).toEqual([]);
  });

  it("bundles the internal packages and declares the runtime ones, transformers.js included", () => {
    const dependencies = Object.keys(manifest.dependencies);
    expect(dependencies.filter((name) => name.startsWith("@habitlore/"))).toEqual([]);
    // transformers.js stays external (native binaries; its model is downloaded on first use), `ai/test` drives the demo.
    expect(dependencies).toEqual(expect.arrayContaining(["@huggingface/transformers", "ai"]));
    for (const version of Object.values(manifest.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // Workspace links mean nothing outside this repository.
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
  });

  it("is version 0.1.0 for Node 22.13 or newer, with its license and repository", () => {
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.engines).toEqual({ node: ">=22.13.0" });
    expect(manifest.license).toBe("MIT");
    expect(manifest.repository).toBeDefined();
    // Nothing points into the unpublished sources.
    expect(manifest.exports).toBeUndefined();
  });
});
