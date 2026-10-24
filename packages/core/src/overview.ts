/** The dashboard's Overview: what the person's history looks like at a glance. */
export interface Overview {
  counts: {
    sessions: number;
    tasks: number;
    /** Clusters that pass the Repeat Rule now. */
    workflows: number;
  };
  /** The busiest Workflows, by Tasks inside the Repeat Rule's window. */
  topWorkflows: { id: number; name: string; tasks: number; sessions: number }[];
  corrections: CorrectionsOverTime;
}

export interface CorrectionsOverTime {
  period: "week";
  /**
   * One entry per week (starting Monday, UTC) from the first analyzed User
   * Message up to the current week, including weeks without Corrections.
   * Empty when nothing is analyzed yet.
   */
  periods: { start: string; corrections: number }[];
}

/** How many Workflows the Overview lists. */
export const TOP_WORKFLOWS = 5;

/** Counts Corrections per week, from the week of the first message to the week of `now`. */
export function correctionsPerWeek(messages: readonly { at: string; correction: boolean }[], now: Date): CorrectionsOverTime {
  if (messages.length === 0) return { period: "week", periods: [] };
  const counts = new Map<string, number>();
  for (const m of messages) {
    const week = weekStart(new Date(m.at));
    counts.set(week, (counts.get(week) ?? 0) + (m.correction ? 1 : 0));
  }
  const first = [...counts.keys()].sort()[0]!;
  const last = [weekStart(now), ...counts.keys()].sort().at(-1)!;
  const periods: CorrectionsOverTime["periods"] = [];
  for (let week = first; week <= last; week = addDays(week, 7)) periods.push({ start: week, corrections: counts.get(week) ?? 0 });
  return { period: "week", periods };
}

/** The Monday (UTC) starting the week `at` falls in, as YYYY-MM-DD. */
function weekStart(at: Date): string {
  const daysSinceMonday = (at.getUTCDay() + 6) % 7;
  return addDays(at.toISOString().slice(0, 10), -daysSinceMonday);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
