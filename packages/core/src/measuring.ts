/**
 * Measuring: the numbers that show over time whether agents are improving.
 * Corrections per Task is the main one (see GLOSSARY.md).
 */

/** Corrections in a calendar month (UTC) of Task start dates. */
export interface MonthCorrections {
  /** `YYYY-MM`. */
  month: string;
  tasks: number;
  corrections: number;
  correctionsPerTask: number;
}

export interface CorrectionsPerTask {
  /** Averaged over every Task; null when there are no Tasks. */
  overall: number | null;
  /** One entry per month that has Tasks, oldest first. */
  byMonth: MonthCorrections[];
}

/** Corrections per Task over `tasks`, each counted in the month it started. */
export function correctionsPerTask(tasks: readonly { at: string; corrections: number }[]): CorrectionsPerTask {
  const months = new Map<string, { tasks: number; corrections: number }>();
  let corrections = 0;
  for (const task of tasks) {
    const month = task.at.slice(0, 7);
    const tally = months.get(month) ?? { tasks: 0, corrections: 0 };
    tally.tasks += 1;
    tally.corrections += task.corrections;
    months.set(month, tally);
    corrections += task.corrections;
  }
  return {
    overall: tasks.length === 0 ? null : average(corrections, tasks.length),
    byMonth: [...months]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, t]) => ({ month, ...t, correctionsPerTask: average(t.corrections, t.tasks) })),
  };
}

/** Rounded to two decimals, so shared numbers don't imply false precision. */
function average(total: number, count: number): number {
  return Math.round((total / count) * 100) / 100;
}
