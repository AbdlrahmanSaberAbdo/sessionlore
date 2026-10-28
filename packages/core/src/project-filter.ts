import { dirname, join } from "node:path";
import type { SectionContext } from "./config.js";
import type { ResolvedProject } from "./project.js";

/**
 * Decides which Projects habitlore may store and show, from the config's
 * `projects.include` and `projects.exclude` lists. An entry is either a
 * Project name (`"shop"`) or a path glob (anything containing `/` or starting
 * with `~`). Exclude always wins; when an include list is set, only Projects
 * on it are allowed, and Sessions without a Project are not.
 */
export class ProjectFilter {
  constructor(
    private readonly include: readonly ProjectPattern[] | null,
    private readonly exclude: readonly ProjectPattern[],
  ) {}

  static allowAll(): ProjectFilter {
    return new ProjectFilter(null, []);
  }

  allows(project: ResolvedProject | null): boolean {
    if (!project) return this.include === null;
    if (this.exclude.some((p) => p.matches(project))) return false;
    return this.include === null || this.include.some((p) => p.matches(project));
  }
}

interface ProjectPattern {
  matches(project: ResolvedProject): boolean;
}

export function parseProjectsSection(raw: unknown, ctx: SectionContext): ProjectFilter {
  if (raw === undefined) return ProjectFilter.allowAll();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.fail("", 'must be an object with "include" and/or "exclude" lists');
  }
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (key !== "include" && key !== "exclude") ctx.fail(key, 'is not a known setting (known: include, exclude)');
  }
  const include = section.include === undefined ? null : parsePatterns(section.include, "include", ctx);
  const exclude = section.exclude === undefined ? [] : parsePatterns(section.exclude, "exclude", ctx);
  return new ProjectFilter(include, exclude);
}

function parsePatterns(raw: unknown, key: string, ctx: SectionContext): ProjectPattern[] {
  if (!Array.isArray(raw)) ctx.fail(key, "must be a list of Project names or path globs");
  return (raw as unknown[]).map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      ctx.fail(`${key}[${index}]`, "must be a non-empty string (a Project name or path glob)");
    }
    const text = (entry as string).trim();
    if (!isPathGlob(text)) return projectNamePattern(text);
    if (!text.startsWith("/") && !text.startsWith("~")) {
      ctx.fail(`${key}[${index}]`, `"${text}" is a relative path; path globs must start with / or ~`);
    }
    return pathGlobPattern(expandHome(text, ctx.homeDir));
  });
}

function isPathGlob(entry: string): boolean {
  return entry.includes("/") || entry.startsWith("~");
}

function expandHome(glob: string, homeDir: string): string {
  if (glob === "~") return homeDir;
  return glob.startsWith("~/") ? join(homeDir, glob.slice(2)) : glob;
}

/**
 * Matches when the glob matches the Project root or any folder containing it,
 * so `~/clients` and `~/clients/*` both cover `~/clients/acme/portal`.
 * `**` matches across folders, `*` and `?` within one folder name.
 */
function pathGlobPattern(glob: string): ProjectPattern {
  const regex = globToRegExp(glob.length > 1 ? glob.replace(/\/+$/, "") : glob);
  return {
    matches: (project) => {
      for (let dir = project.root; ; dir = dirname(dir)) {
        if (regex.test(dir)) return true;
        if (dirname(dir) === dir) return false;
      }
    },
  };
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      source += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function projectNamePattern(name: string): ProjectPattern {
  return { matches: (project) => project.name === name };
}
