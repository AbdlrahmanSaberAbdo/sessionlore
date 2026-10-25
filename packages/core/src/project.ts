import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface ResolvedProject {
  /** The git repository root (the main repository for worktrees), or the folder itself outside git. */
  root: string;
  name: string;
}

/**
 * Maps a working directory to its Project: the root of the git repository it
 * is in, with linked worktrees resolved to their main repository. A folder
 * outside git is its own Project. Reads `.git` entries directly instead of
 * running git, so it works without git installed and on folders that have
 * since been deleted (their ancestors are still checked).
 */
export function resolveProject(cwd: string): ResolvedProject {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    const root = repositoryRootAt(dir);
    if (root) return { root, name: basename(root) };
    if (dirname(dir) === dir) break;
  }
  return { root: start, name: basename(start) || start };
}

/** If `dir` contains a `.git` entry, the main repository root it belongs to. */
function repositoryRootAt(dir: string): string | null {
  const dotGit = resolve(dir, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dir;

  // A `.git` file points at the real git dir: a worktree's admin dir or a submodule's module dir.
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!match?.[1]) return dir;
  const gitDir = resolvePath(dir, match[1].trim());

  const commonDirFile = resolve(gitDir, "commondir");
  if (!existsSync(commonDirFile)) return dir; // submodule or detached git dir: its own repository
  const commonDir = resolvePath(gitDir, readFileSync(commonDirFile, "utf8").trim());
  return basename(commonDir) === ".git" ? dirname(commonDir) : dir;
}

function resolvePath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
