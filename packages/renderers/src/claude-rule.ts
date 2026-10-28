import { join } from "node:path";
import { RenderError, type Renderer, type Scope } from "@habitlore/core";

/**
 * The Claude Rule Renderer: a Rule Suggestion becomes a bullet in a section of
 * the Scope's `CLAUDE.md` that habitlore manages. Everything outside that
 * section is left byte-for-byte as it was.
 */

export const RULES_START = "<!-- habitlore:rules:start -->";
export const RULES_END = "<!-- habitlore:rules:end -->";
const HEADING = "## Rules from habitlore";

/** The section as sessionlore, habitlore's earlier name, wrote it. Rewritten with the current markers on the next write. */
const OLD_SECTION = [
  ["<!-- sessionlore:rules:start -->\n## Rules from sessionlore\n", `${RULES_START}\n${HEADING}\n`],
  ["<!-- sessionlore:rules:start -->", RULES_START],
  ["<!-- sessionlore:rules:end -->", RULES_END],
] as const;

function withCurrentMarkers(content: string | null): string | null {
  return content === null ? null : OLD_SECTION.reduce((text, [old, current]) => text.replace(old, current), content);
}

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
    const text = suggestion.rule.replace(/\s*\n\s*/g, " ").trim();
    const { target } = suggestion;
    if (target?.kind === "rule") {
      return [{ path: target.path, content: withLineReplaced(withCurrentMarkers(readFile(target.path)), target.line, text, target.path) }];
    }
    const path = claudeMdPath(suggestion.scope, homeDir);
    return [{ path, content: withRule(withCurrentMarkers(readFile(path)), `- ${text}`, path) }];
  },
  installed({ homeDir, projects, readFile }) {
    const files = [join(homeDir, ".claude", "CLAUDE.md"), ...projects.map((p) => join(p.path, "CLAUDE.md"))];
    return [...new Set(files)].flatMap((path) => ruleLines(readFile(path)).map((line) => ({ kind: "rule" as const, path, line })));
  },
};

/** Lines of a `CLAUDE.md` that read as standing instructions: not headings, markers, blank lines or code. */
function ruleLines(content: string | null): string[] {
  if (content === null) return [];
  const lines: string[] = [];
  let inCode = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    else if (!inCode && line.trim() !== "" && !/^\s*(#|<!--|>|\|)/.test(line) && !/^\s*[-*_]{3,}\s*$/.test(line)) lines.push(line);
  }
  return lines;
}

/** `content` with its first line equal to `line` replaced by `text`, keeping the line's indent and list marker. */
function withLineReplaced(content: string | null, line: string, text: string, path: string): string {
  const lines = content?.split("\n") ?? [];
  const index = lines.indexOf(line);
  if (index === -1) {
    throw new RenderError(`The line this Rule updates is no longer in ${path}: "${line}". Reject it, or restore the line and accept again.`);
  }
  const marker = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)?.[0] ?? line.match(/^\s*/)![0];
  lines[index] = `${marker}${text}`;
  return lines.join("\n");
}

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
    throw new RenderError(`The section habitlore manages in ${path} is damaged; fix or remove its markers and accept again.`);
  }
  const inside = content.slice(start, end);
  if (inside.split("\n").includes(bullet)) return content; // already there
  const before = content.slice(0, end);
  return `${before}${before.endsWith("\n") ? "" : "\n"}${bullet}\n${content.slice(end)}`;
}
