# v2 plan

Work deliberately left out of v1. v1 succeeds when habitlore finds a repeated workflow and drafts a skill you actually keep; everything here builds on that.

Each item says why it waits.

## Proving it helped

- **Before/after dashboard.** For each accepted suggestion, chart corrections per task (the main metric) and turns per task (the secondary one) in that workflow, before and after the acceptance date.
  *Why later:* needs weeks of data after acceptance. v1 already records acceptance dates and skill usage so this data exists when v2 starts.
- **Skill usage report.** How often each accepted skill was actually invoked, and in which projects. Suggest retiring skills nobody uses.

## More kinds of suggestions

- **Hooks.** Turn mechanical, repeated corrections (for example "run the formatter after editing") into Claude Code hooks.
- **Scheduled jobs.** Suggest `/loop`, `/schedule` or cron jobs for recurring tasks found in history.
  *Why later:* hooks and jobs run code, so they need extra safety review and a dry-run mode. Skills and rules are only text.

## More vendors

v1 stores suggestions in a format-neutral form and ships only the Claude renderers (`SKILL.md` and `CLAUDE.md` rules). v2 adds renderers for:

- Cursor rules (`.cursor/rules`)
- `AGENTS.md` (Codex and others)
- Gemini CLI (`GEMINI.md`)
- Other formats as demand appears

## More sources

- **Codex adapter** (`~/.codex/sessions` JSONL plus the `state_*.sqlite` index). The third adapter, and the proof that the adapter interface works.
- Gemini CLI, OpenCode, Copilot CLI and others, ideally contributed by the community.

## Live mode

- **Hook-based capture** of sessions as they happen, instead of only reading finished sessions.
  *Why later:* not needed to mine patterns, and live monitoring is what Agent Monitor already does well.

## Platform and UI

- **Windows support** (different storage paths for Claude Code and Cursor).
- **Switchable mind map views**: harness → project → task type, and others, alongside v1's project → workflow → tasks → sessions.
- **Terminal summary UI** (Ink) for a quick look without opening the browser.

## Testing suggestions

- **Run drafted skills through the Claude Agent SDK** against a replayed task before accepting, to show whether the skill changes the agent's behaviour.
