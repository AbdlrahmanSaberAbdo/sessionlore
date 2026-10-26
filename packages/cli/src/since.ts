const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads a `--since` window: `Nd` or `Nw` counted back from `now`, or an ISO
 * date (`2026-09-01`, from the start of that day in UTC). Null when it can't.
 */
export function parseSince(value: string, now: Date): Date | null {
  const relative = /^(\d+)([dw])$/.exec(value);
  if (relative) {
    const n = Number(relative[1]);
    if (n < 1) return null;
    return new Date(now.getTime() - n * (relative[2] === "w" ? 7 : 1) * DAY_MS);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Date rolls 2026-02-30 over into March; a day that doesn't exist is a mistake.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export const sinceHelp = "a number of days or weeks (30d, 2w) or a date (2026-09-01)";
