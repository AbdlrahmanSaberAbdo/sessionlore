import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

/**
 * A throwaway home directory for tests and the demo dataset.
 * Paths are real (symlinks resolved) so recorded working directories match
 * what sessionlore sees when it resolves them.
 */
export class FixtureHome {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  /** A new, empty home directory in `parent` (the system's temp folder by default). */
  static create(prefix = "sessionlore-home-", parent = tmpdir()): FixtureHome {
    return new FixtureHome(realpathSync(mkdtempSync(join(parent, prefix))));
  }

  /** Absolute path of `relPath` inside the home directory. */
  resolve(relPath: string): string {
    return join(this.path, relPath);
  }

  /** A plain folder outside any git repository. */
  folder(relPath: string): string {
    const dir = this.resolve(relPath);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A git repository laid out the way `git init` lays it out. */
  gitRepo(relPath: string): string {
    const dir = this.folder(relPath);
    mkdirSync(join(dir, ".git", "objects"), { recursive: true });
    mkdirSync(join(dir, ".git", "refs"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    return dir;
  }

  /** A linked worktree of `repoDir`, laid out the way `git worktree add` lays it out. */
  gitWorktree(repoDir: string, relPath: string): string {
    const dir = this.folder(relPath);
    const name = basename(dir);
    const adminDir = join(repoDir, ".git", "worktrees", name);
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(adminDir, "gitdir"), `${join(dir, ".git")}\n`);
    writeFileSync(join(adminDir, "commondir"), `${relative(adminDir, join(repoDir, ".git"))}\n`);
    writeFileSync(join(adminDir, "HEAD"), `ref: refs/heads/${name}\n`);
    writeFileSync(join(dir, ".git"), `gitdir: ${adminDir}\n`);
    return dir;
  }

  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}
