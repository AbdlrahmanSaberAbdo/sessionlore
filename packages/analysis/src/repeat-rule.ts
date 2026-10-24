/**
 * The Repeat Rule (see GLOSSARY.md): a Cluster or Correction Cluster earns a
 * Suggestion only once it has at least `minMembers` members across at least
 * `minSessions` Sessions, counting only members from the last `windowDays` days.
 */
export interface RepeatRule {
  minMembers: number;
  minSessions: number;
  windowDays: number;
}

export const defaultRepeatRule: RepeatRule = { minMembers: 3, minSessions: 2, windowDays: 60 };

export interface Member {
  /** Id of the Session the member belongs to. */
  session: string;
  at: Date;
}

export interface RepeatRuleResult {
  passes: boolean;
  /** Members and distinct Sessions counted, i.e. those inside the window. */
  counted: { members: number; sessions: number };
  /** How many more members and Sessions it needs to pass; zero for both when it passes. */
  needs: { members: number; sessions: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function applyRepeatRule(members: readonly Member[], rule: RepeatRule, now: Date): RepeatRuleResult {
  const since = now.getTime() - rule.windowDays * DAY_MS;
  const counted = members.filter((m) => m.at.getTime() >= since && m.at.getTime() <= now.getTime());
  const sessions = new Set(counted.map((m) => m.session)).size;
  const needs = {
    members: Math.max(0, rule.minMembers - counted.length),
    sessions: Math.max(0, rule.minSessions - sessions),
  };
  return {
    passes: needs.members === 0 && needs.sessions === 0,
    counted: { members: counted.length, sessions },
    needs,
  };
}
