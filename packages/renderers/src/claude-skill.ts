import { join } from "node:path";
import {
  RenderError,
  type InstalledContext,
  type InstalledItem,
  type Renderer,
  type Scope,
  type SkillSuggestion,
} from "@sessionlore/core";

/**
 * The Claude Skill Renderer: a Skill Suggestion becomes a skill folder holding
 * a `SKILL.md` with `name` and `description` frontmatter and the procedure as
 * its body, in the Scope's skill directory. A Suggestion with a Target
 * rewrites that `SKILL.md` instead, keeping its name and other frontmatter.
 */

/** Longest skill name Claude Code accepts. */
const MAX_NAME = 64;
/** How deep plugin folders are searched for skills. */
const PLUGIN_DEPTH = 8;

/** The skill directory for a Scope: `<project>/.claude/skills` or `~/.claude/skills`. */
export function claudeSkillDir(scope: Scope, homeDir: string): string {
  return join(scope.kind === "project" ? scope.project.path : homeDir, ".claude", "skills");
}

/** Where Claude Code keeps the installed plugins' files: `<marketplace>/<plugin>/<version>/...`. */
export function claudePluginCacheDir(homeDir: string): string {
  return join(homeDir, ".claude", "plugins", "cache");
}

/** A Claude skill name (lowercase letters, digits and hyphens) for a Suggestion. */
export function claudeSkillName(suggestion: Pick<SkillSuggestion, "id" | "title">): string {
  const name = suggestion.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_NAME)
    .replace(/^-+|-+$/g, "");
  return name || `skill-${suggestion.id}`;
}

export const claudeSkillRenderer: Renderer = {
  id: "claude-skill",
  harness: "claude-code",
  kind: "skill",
  render(suggestion, { homeDir, readFile }) {
    if (suggestion.kind !== "skill") throw new RenderError(`The Claude Skill Renderer can't render a ${suggestion.kind}.`);
    const { target } = suggestion;
    if (target?.kind === "skill") {
      const current = readFile(target.path);
      if (current === null) {
        throw new RenderError(`The skill this Suggestion updates is gone from ${target.path}; reject it or restore the file.`);
      }
      return [{ path: target.path, content: skillMarkdown(target.name, suggestion, frontmatter(current)) }];
    }
    const name = claudeSkillName(suggestion);
    const path = join(claudeSkillDir(suggestion.scope, homeDir), name, "SKILL.md");
    if (readFile(path) !== null) {
      throw new RenderError(`A skill named ${name} already exists at ${path}; sessionlore won't overwrite it.`);
    }
    return [{ path, content: skillMarkdown(name, suggestion, []) }];
  },
  installed(context) {
    const owned = [context.homeDir, ...context.projects.map((p) => p.path)].flatMap((root) =>
      skillsIn(join(root, ".claude", "skills"), context, null, 1),
    );
    const cache = claudePluginCacheDir(context.homeDir);
    const plugins = context.listDir(cache).flatMap((marketplace) =>
      marketplace.isDirectory
        ? context
            .listDir(join(cache, marketplace.name))
            .flatMap((plugin) =>
              plugin.isDirectory ? skillsIn(join(cache, marketplace.name, plugin.name), context, plugin.name, PLUGIN_DEPTH) : [],
            )
        : [],
    );
    return [...owned, ...plugins];
  },
};

/** Skill folders (holding a `SKILL.md`) under `dir`, down to `depth` levels. */
function skillsIn(dir: string, context: InstalledContext, plugin: string | null, depth: number): InstalledItem[] {
  if (depth === 0) return [];
  return context.listDir(dir).flatMap((entry): InstalledItem[] => {
    if (!entry.isDirectory) return [];
    const folder = join(dir, entry.name);
    const path = join(folder, "SKILL.md");
    const content = context.readFile(path);
    if (content === null) return skillsIn(folder, context, plugin, depth - 1);
    const fields = frontmatter(content);
    return [
      {
        kind: "skill",
        path,
        name: unquote(field(fields, "name")) || entry.name,
        description: unquote(field(fields, "description")),
        content,
        plugin,
      },
    ];
  });
}

/** The lines between a file's opening `---` and closing `---`; [] when it has none. */
function frontmatter(content: string): string[] {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end === -1 ? [] : lines.slice(1, end);
}

function field(lines: readonly string[], key: string): string {
  const line = lines.find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function unquote(value: string): string {
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/**
 * The `SKILL.md` for a Suggestion. `kept` is the current frontmatter of the
 * Target, whose fields other than name and description stay as they are.
 */
function skillMarkdown(name: string, suggestion: SkillSuggestion, kept: readonly string[]): string {
  const description = `${withPeriod(suggestion.title)} ${suggestion.trigger}`.replace(/\s+/g, " ").trim();
  const companion = suggestion.companionOf;
  return [
    "---",
    `name: ${name}`,
    // A JSON string is a valid YAML double-quoted scalar, so any punctuation in it is safe.
    `description: ${JSON.stringify(description)}`,
    ...otherFields(kept),
    "---",
    "",
    `# ${suggestion.title}`,
    "",
    suggestion.trigger,
    "",
    ...(companion ? [`Use it together with the \`${companion.plugin}:${companion.name}\` skill, which it complements.`, ""] : []),
    "## Steps",
    "",
    ...suggestion.steps.map((step, i) => `${i + 1}. ${step.replace(/\s*\n\s*/g, " ")}`),
    "",
  ].join("\n");
}

/** Frontmatter lines without `name` and `description`, including any indented lines continuing them. */
function otherFields(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\S/.test(line)) skipping = /^(name|description):/.test(line);
    if (!skipping) kept.push(line);
  }
  return kept;
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
