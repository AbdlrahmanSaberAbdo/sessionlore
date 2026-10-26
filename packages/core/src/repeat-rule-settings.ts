import { defaultRepeatRule, type RepeatRule } from "@sessionlore/analysis";
import { isPlainObject, type SectionContext } from "./config.js";

/** The config file's `repeatRule` section. Each setting is optional and falls back to the default. */
export function parseRepeatRuleSection(raw: unknown, ctx: SectionContext): RepeatRule {
  if (raw === undefined) return defaultRepeatRule;
  if (!isPlainObject(raw)) ctx.fail("", `must be an object with ${known}`);
  const section = raw as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (!(key in defaultRepeatRule)) ctx.fail(key, `is not a known setting (known: ${known})`);
  }
  const rule = { ...defaultRepeatRule };
  for (const key of Object.keys(defaultRepeatRule) as (keyof RepeatRule)[]) {
    const value = section[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) ctx.fail(key, "must be a whole number of at least 1");
    rule[key] = value as number;
  }
  return rule;
}

const known = Object.keys(defaultRepeatRule).join(", ");
