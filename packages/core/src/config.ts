import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseModelProviderSection, type ModelProviderSettings } from "./model-provider-settings.js";
import { ProjectFilter, parseProjectsSection } from "./project-filter.js";
import { dataDir } from "./store/store.js";

/**
 * sessionlore's config file: `~/.sessionlore/config.json`. Optional; a missing
 * file means defaults everywhere. Each top-level key is a section with its own
 * parser below; add a section by adding a key to `Config` and a parser to
 * `sections`. Unknown keys are rejected so typos never silently do nothing.
 */

export interface Config {
  projects: ProjectFilter;
  /** Null when the file has no `modelProvider` section. */
  modelProvider: ModelProviderSettings | null;
}

/** A config file problem, with a message that names the file and the offending key. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** What a section parser gets: the raw value plus enough context to report problems. */
export interface SectionContext {
  homeDir: string;
  /** Reports a problem at `key` (a dotted path below the section) and stops loading. */
  fail(key: string, problem: string): never;
}

type SectionParsers = { [K in keyof Config]: (raw: unknown, ctx: SectionContext) => Config[K] };

const sections: SectionParsers = {
  projects: parseProjectsSection,
  modelProvider: parseModelProviderSection,
};

export function configPath(homeDir: string): string {
  return join(dataDir(homeDir), "config.json");
}

export function loadConfig(homeDir: string): Config {
  const file = configPath(homeDir);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}";
  return parseConfig(text, { homeDir, file });
}

export function parseConfig(text: string, where: { homeDir: string; file: string }): Config {
  const fail = (key: string, problem: string): never => {
    throw new ConfigError(`Invalid config file ${where.file}: ${key ? `\`${key}\` ` : ""}${problem}`);
  };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail("", `is not valid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(raw)) fail("", "must hold a JSON object");
  const root = raw as Record<string, unknown>;

  for (const key of Object.keys(root)) {
    if (!(key in sections)) fail(key, `is not a known setting (known: ${Object.keys(sections).join(", ")})`);
  }
  const config = {} as Record<string, unknown>;
  for (const [name, parse] of Object.entries(sections) as [string, (raw: unknown, ctx: SectionContext) => unknown][]) {
    config[name] = parse(root[name], {
      homeDir: where.homeDir,
      fail: (key, problem) => fail(key ? `${name}.${key}` : name, problem),
    });
  }
  return config as unknown as Config;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
