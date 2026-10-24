import { join } from "node:path";
import { RenderError, type Renderer, type Scope } from "@sessionlore/core";

/**
 * The Claude Rule Renderer: a Rule Suggestion becomes a bullet in a section of
 * the Scope's `CLAUDE.md` that sessionlore manages. Everything outside that
 * section is left byte-for-byte as it was.
 */

export const RULES_START = "<!-- sessionlore:rules:start -->";
export const RULES_END = "<!-- sessionlore:rules:end -->";
const HEADING = "## Rules from sessionlore";

/** The `CLAUDE.md` for a Scope: `<project>/CLAUDE.md` or `~/.claude/CLAUDE.md`. */
export function claudeMdPath(scope: Scope, homeDir: string): string {
  return scope.kind === "project" ? join(scope.project.path, "CLAUDE.md") : join(homeDir, ".claude", "CLAUDE.md");
}

export const claudeRuleRenderer: Renderer = {
  id: "claude-rule",
  harness: "claude-code",
  kind: "rule",
  render(suggestion, { homeDir, readFile }) {
    if (suggestion.kind !== "rule") throw new RenderError(`The Claude Rule Renderer can't render a ${suggestion.kind}.`);
    const path = claudeMdPath(suggestion.scope, homeDir);
    const bullet = `- ${suggestion.rule.replace(/\s*\n\s*/g, " ").trim()}`;
    return [{ path, content: withRule(readFile(path), bullet, path) }];
  },
};

/** `content` with `bullet` added to its managed section, creating the section (or the file) when missing. */
function withRule(content: string | null, bullet: string, path: string): string {
  const section = (bullets: string) => `${RULES_START}\n${HEADING}\n\n${bullets}${RULES_END}\n`;
  if (content === null || content === "") return section(`${bullet}\n`);

  const start = content.indexOf(RULES_START);
  const end = content.indexOf(RULES_END);
  if (start === -1 && end === -1) {
    const separator = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return content + separator + section(`${bullet}\n`);
  }
  if (start === -1 || end === -1 || end < start || content.indexOf(RULES_START, start + 1) !== -1) {
    throw new RenderError(`The section sessionlore manages in ${path} is damaged; fix or remove its markers and accept again.`);
  }
  const inside = content.slice(start, end);
  if (inside.split("\n").includes(bullet)) return content; // already there
  const before = content.slice(0, end);
  return `${before}${before.endsWith("\n") ? "" : "\n"}${bullet}\n${content.slice(end)}`;
}
