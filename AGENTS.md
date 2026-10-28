# habitlore

Local-first tool that reads AI coding sessions (Claude Code and Cursor to start), finds repeated workflows, and drafts agent skills and rules from them. See `README.md` for the pitch and `docs/v2-plan.md` for deferred work.

## Agent skills

### Issue tracker

GitHub Issues on AbdlrahmanSaberAbdo/sessionlore, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
