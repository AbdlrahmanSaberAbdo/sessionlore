import { join } from "node:path";
import { RenderError, type Renderer, type Scope, type SkillSuggestion } from "@sessionlore/core";

/**
 * The Claude Skill Renderer: a Skill Suggestion becomes a skill folder holding
 * a `SKILL.md` with `name` and `description` frontmatter and the procedure as
 * its body, in the Scope's skill directory.
 */

/** Longest skill name Claude Code accepts. */
const MAX_NAME = 64;

/** The skill directory for a Scope: `<project>/.claude/skills` or `~/.claude/skills`. */
export function claudeSkillDir(scope: Scope, homeDir: string): string {
  return join(scope.kind === "project" ? scope.project.path : homeDir, ".claude", "skills");
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
    const name = claudeSkillName(suggestion);
    const path = join(claudeSkillDir(suggestion.scope, homeDir), name, "SKILL.md");
    if (readFile(path) !== null) {
      throw new RenderError(`A skill named ${name} already exists at ${path}; sessionlore won't overwrite it.`);
    }
    return [{ path, content: skillMarkdown(name, suggestion) }];
  },
};

function skillMarkdown(name: string, suggestion: SkillSuggestion): string {
  const description = `${withPeriod(suggestion.title)} ${suggestion.trigger}`.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${name}`,
    // A JSON string is a valid YAML double-quoted scalar, so any punctuation in it is safe.
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${suggestion.title}`,
    "",
    suggestion.trigger,
    "",
    "## Steps",
    "",
    ...suggestion.steps.map((step, i) => `${i + 1}. ${step.replace(/\s*\n\s*/g, " ")}`),
    "",
  ].join("\n");
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
