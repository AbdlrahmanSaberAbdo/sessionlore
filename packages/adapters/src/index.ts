import type { Adapter } from "@sessionlore/core";
import { claudeCodeAdapter } from "./claude-code/adapter.js";

export { claudeCodeAdapter };

/** Every Adapter sessionlore ships, in the order Scan runs them. */
export const allAdapters: readonly Adapter[] = [claudeCodeAdapter];
