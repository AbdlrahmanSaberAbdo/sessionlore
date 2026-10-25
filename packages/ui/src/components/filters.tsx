import type { BrowseFilter, FilterOptions, HarnessId } from "@sessionlore/core";
import { filterQuery, navigate } from "../router.js";

const harnessNames: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor" };

export function harnessName(harness: HarnessId): string {
  return harnessNames[harness] ?? harness;
}

/** Project, Harness and date range filters; changing one updates the page's query string. */
export function FilterBar({ filter, options }: { filter: BrowseFilter; options: FilterOptions }) {
  const set = (key: keyof BrowseFilter, value: string) =>
    navigate(location.pathname + filterQuery({ ...filter, [key]: value || undefined }));
  return (
    <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      <label>
        Project
        <select value={filter.project ?? ""} onChange={(e) => set("project", e.target.value)}>
          <option value="">All Projects</option>
          {options.projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Harness
        <select value={filter.harness ?? ""} onChange={(e) => set("harness", e.target.value)}>
          <option value="">All Harnesses</option>
          {options.harnesses.map((h) => (
            <option key={h} value={h}>
              {harnessName(h)}
            </option>
          ))}
        </select>
      </label>
      <label>
        From
        <input type="date" value={filter.from ?? ""} onChange={(e) => set("from", e.target.value)} />
      </label>
      <label>
        To
        <input type="date" value={filter.to ?? ""} onChange={(e) => set("to", e.target.value)} />
      </label>
    </form>
  );
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : `${word}s`}`;
}
