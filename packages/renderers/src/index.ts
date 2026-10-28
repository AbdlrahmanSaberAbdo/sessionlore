import type { Renderer } from "@habitlore/core";
import { claudeRuleRenderer } from "./claude-rule.js";
import { claudeSkillRenderer } from "./claude-skill.js";

export { claudeMdPath, claudeRuleRenderer, RULES_END, RULES_START } from "./claude-rule.js";
export { claudePluginCacheDir, claudeSkillDir, claudeSkillName, claudeSkillRenderer } from "./claude-skill.js";

/** Every Renderer habitlore ships. */
export const allRenderers: readonly Renderer[] = [claudeSkillRenderer, claudeRuleRenderer];
