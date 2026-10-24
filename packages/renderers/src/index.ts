import type { Renderer } from "@sessionlore/core";
import { claudeSkillRenderer } from "./claude-skill.js";

export { claudeSkillDir, claudeSkillName, claudeSkillRenderer } from "./claude-skill.js";

/** Every Renderer sessionlore ships. */
export const allRenderers: readonly Renderer[] = [claudeSkillRenderer];
