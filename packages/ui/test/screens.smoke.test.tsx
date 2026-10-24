import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Overview } from "@sessionlore/core";
import { OverviewScreen } from "../src/screens/overview.js";

/**
 * The UI's smoke test: each screen renders the data the API returns. UI logic
 * is kept thin; behaviour is tested through the API (Seam 2).
 */

const overview: Overview = {
  counts: { sessions: 12, tasks: 31, workflows: 2 },
  topWorkflows: [
    { id: 4, name: "Write database migrations", tasks: 7, sessions: 5 },
    { id: 9, name: "Update release notes", tasks: 3, sessions: 3 },
  ],
  corrections: {
    period: "week",
    periods: [
      { start: "2026-05-04", corrections: 6 },
      { start: "2026-05-11", corrections: 0 },
      { start: "2026-05-18", corrections: 3 },
    ],
  },
};

describe("UI screens", () => {
  it("Overview shows the counts, top Workflows and a Corrections-over-time chart", () => {
    const html = renderToStaticMarkup(<OverviewScreen overview={overview} />);

    for (const text of ["12", "31", "Sessions", "Tasks", "Workflows", "Write database migrations", "Update release notes"]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/<svg[^>]*aria-label="Corrections per week"/);
    expect(html.match(/<rect/g)).toHaveLength(3);
    expect(html).toContain("2026-05-04: 6 Corrections");
  });
});
