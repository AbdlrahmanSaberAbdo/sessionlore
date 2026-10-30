# How other tools share agent knowledge and learn review taste

Research for issue #37. Snapshot taken 2026-10-30. This records facts only; it makes no decisions. Each claim links its source. Where only a secondary source exists, the claim says so.

## Question

How do existing tools share agent knowledge across a team, and how do they learn review taste from PR comments? For each tool: what is shared, where it lives, how consent and privacy work, and what is paid. Then: what does none of them do that habitlore could?

## Part A: Sharing agent instructions and skills

### AGENTS.md (open convention)
- A plain Markdown file of project instructions for agents, committed to the repo. OpenAI and Anthropic donated it to the Linux Foundation's Agentic AI Foundation (AAIF) on 2025-12-09, alongside MCP and Block's Goose. [OpenAI](https://openai.com/index/agentic-ai-foundation/)
- Cursor reads a root `AGENTS.md` and nested ones, and the more specific file wins. [Cursor docs](https://cursor.com/docs/rules) Copilot code review reads it too. [GitHub docs](https://docs.github.com/en/copilot/tutorials/customize-code-review)
- Sharing happens through git. No telemetry or learning is involved, and nobody consents beyond reviewing the commit.

### Agent Skills / SKILL.md (open format)
- Anthropic published the spec at agentskills.io in December 2025. Secondary sources report that 30+ tools read it, including Codex (`.agents/skills`), Copilot (`.github/skills`) and Cursor (`.cursor/skills`). [noqta.tn (secondary)](https://noqta.tn/en/news/skill-md-open-standard-30-ai-coding-tools-adoption-2026), [Daniel Vaughan (secondary)](https://codex.danielvaughan.com/2026/05/05/agent-skills-open-standard-portable-skills-codex-cli-cross-agent/). I did not check exact paths against each vendor's docs.

### Claude Code: plugin marketplaces and managed settings
- **What is shared:** plugins that bundle skills, agents, hooks and MCP servers. A marketplace is a catalog that Claude Code fetches from a git repo, a URL or a local path. [Claude Code docs: org plugins](https://code.claude.com/docs/en/plugins/org)
- **Where it lives:** the marketplace lives in a git repo the org owns. Admins push it with managed settings (`extraKnownMarketplaces` plus `enabledPlugins`). Managed settings arrive either from the claude.ai admin console (server-managed, Owner role) or through MDM or a `managed-settings.json` file, and users can't override them. A repo can also require plugins for its contributors through `.claude/settings.json`, which applies only after the contributor trusts the folder. [same](https://code.claude.com/docs/en/plugins/org)
- **Governance:** `strictKnownMarketplaces` and `blockedMarketplaces` allowlist or block sources. `disableSideloadFlags` and `strictPluginOnlyCustomization` lock down local additions. OpenTelemetry events record installs and loads. On Enterprise, an Analytics API returns per-plugin install and invocation counts, grouped by user or group. [same](https://code.claude.com/docs/en/plugins/org)
- **claude.ai org skills:** on Team and Enterprise, Owners provision skills to every member, and members can toggle them. Members can share their own skills with colleagues or the whole org, but peer sharing is off by default. [Anthropic help](https://support.claude.com/en/articles/12512180-use-skills-in-claude), [Anthropic blog](https://claude.com/blog/organization-skills-and-directory)
- **Paid?** Marketplaces in git are free on any plan. Server-managed settings, org skill provisioning and the Analytics API need Team or Enterprise.

### Cursor: Team Rules, Project Rules, User Rules
- **Team Rules:** admins manage them in the Cursor dashboard on Team and Enterprise plans. Each rule is either enforced (users can't turn it off) or optional. Team Rules outrank Project and User Rules. [Cursor docs](https://cursor.com/docs/rules), [enterprise settings](https://cursor.com/docs/account/teams/enterprise-settings)
- **Project Rules:** `.mdc` files in `.cursor/rules`, committed to git. **User Rules:** personal rules, stored in Cursor's settings.
- **Learning:** the rules docs describe no automatic learning. Rules change only through `/create-rule` or a manual edit. [Cursor docs](https://cursor.com/docs/rules)

### Copilot: custom instructions
- `.github/copilot-instructions.md`, path-scoped `.github/instructions/**/*.instructions.md`, and `AGENTS.md`, all in the repo. Code review reads only the first 4,000 characters of each file. [GitHub docs](https://docs.github.com/en/copilot/tutorials/customize-code-review)

### Devin: Knowledge
- Devin stores Knowledge items in its own platform, not in the repo. It suggests new items, and updates to existing ones, from your feedback in chat. A human reviews, edits or dismisses each suggestion before it is saved. A scheduled session can also deduplicate items and resolve conflicting ones. [Devin docs](https://docs.devin.ai/product-guides/knowledge), [advanced mode](https://docs.devin.ai/product-guides/advanced-mode)
- This is the closest hosted analog to "learn from corrections, then human review". It learns from Devin's own sessions only.

## Part B: Review bots that learn from reviewer feedback

### CodeRabbit: Learnings
- **Signal:** someone tells `@coderabbitai` a preference in a PR or issue comment, or imports a file such as a style guide or a CSV export. Learnings are explicit instructions; CodeRabbit does not infer them silently. [CodeRabbit docs](https://docs.coderabbit.ai/knowledge-base/learnings)
- **Where:** CodeRabbit's own database, tied to the org on the git platform, and viewable at app.coderabbit.ai/learnings. Scope is `local` (this repo), `global` (the whole org) or `auto` (local for public repos, global for private ones). [same](https://docs.coderabbit.ai/knowledge-base/learnings)
- **Consent and privacy:** `approval_delay` (0–30 days) can hold new learnings for an admin to approve. Credentials are redacted when a learning is written. An org-level opt-out turns off learnings and deletes the stored data. Admins can export learnings as CSV, and Enterprise adds an API. [same](https://docs.coderabbit.ai/knowledge-base/learnings)
- **Paid?** Pro and above. Open-source projects get Pro+ features free. [CodeRabbit plans](https://docs.coderabbit.ai/management/plans)

### Greptile: memory and learning
- **Signal:** 👍/👎 reactions, replies (positive, dismissive or adding context), and commits: Greptile checks whether a comment was addressed between the first and last commit. It also uses past PR comments, and it suggests custom rules from repeated team behavior (May 2026). [Greptile changelog](https://greptile.com/changelog), [training docs](https://www.greptile.com/docs/code-review/training-the-learning-system)
- **Where:** explicit rules live in `greptile.json`, `.greptile/` in the repo, or the dashboard. The docs don't say where learned memory is stored. Greptile indexes existing `CLAUDE.md`, `AGENTS.md` and Cursor rules as context. [Greptile learning](https://www.greptile.com/feature/learning)
- **Agents:** an MCP server and a Claude Code plugin manage custom context and repo rules from the editor. Neither source says they expose learned memory. [changelog](https://greptile.com/changelog)
- **Paid?** Paid product with a 14-day trial. [Greptile learning](https://www.greptile.com/feature/learning)

### Cursor Bugbot: learned rules
- **Signal:** reactions and replies to Bugbot's comments, plus human reviewers' PR comments, become candidate rules. Candidates that gather signal are promoted, and rules that stop being useful are disabled. Launched 2026-04-08. [Cursor changelog](https://cursor.com/changelog/04-08-26)
- **Where:** learned rules live in the Bugbot dashboard, not in the repo. A forum request asks for a way to promote them into repo rules through git. [Cursor forum](https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018) Hand-written rules go in `.cursor/BUGBOT.md`. Secondary sources say Bugbot doesn't read `.cursor/rules`. [developertoolkit (secondary)](https://developertoolkit.ai/en/cursor-ide/ship/bugbot/)
- **Paid?** Bugbot is a paid add-on. The changelog doesn't name a tier for learned rules.

### GitHub Copilot: Memory (code review included)
- **Signal:** Copilot agents (coding agent, code review, CLI) record facts about a repo: conventions, architecture, file dependencies. All three agents share the memories. Each memory is checked against the current code before use, and expires after 28 days. [GitHub changelog 2026-03-04](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/), [GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
- **Where:** GitHub's servers, one repo per memory. Repo owners can review and delete memories in Settings → Copilot → Memory.
- **Consent:** on by default for Pro and Pro+. Org and enterprise admins decide through policy, and users can opt out. GitHub reports +2% positive feedback on review comments with memory enabled (77% vs 75%). [GitHub blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)

### Qodo Merge: auto best practices
- **Signal:** suggestions the team accepts are logged to a repo wiki page. Once a month, Qodo distills them into a `.pr_agent_auto_best_practices` file, capped at 5 patterns by default. Later reviews flag "learned best practice" violations. Teams can edit the file. [Qodo docs](https://qodo-merge-docs.qodo.ai/core-abilities/auto_best_practices)
- **Where:** the repo wiki, on GitHub. Qodo is paid, and its open-source PR-Agent is the base.

### Graphite Agent (formerly Diamond)
- Custom rules (regex or AI) and exclusions, set in the dashboard. I found no documentation saying it learns from a team's reactions or replies. [Graphite guide](https://graphite.dev/guides/ai-code-reviewers-how-they-work), [Braintrust case study (internal evals only)](https://www.braintrust.dev/customers/graphite)

### Anthropic Code Review (managed)
- Reads `REVIEW.md` and `CLAUDE.md` from the base branch. The docs describe no learning from feedback. Team and Enterprise only; not available under ZDR or HIPAA. [Claude Code docs](https://code.claude.com/docs/en/code-review)

### Community skills that mine review history locally
- **rule-miner** (vanducng, MIT, v0.1.0): a Claude Code skill. It mines Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), git history and PR review history (via `gh`) for repeated corrections. It clusters them (≥2 distinct events), runs a verifier and a skeptic over each candidate, and proposes `CLAUDE.md`/`AGENTS.md` rules that are written only after the user approves. [rule-miner SKILL.md](https://claudskills.com/skills/rule-miner/SKILL.md)
- **pr-learning** (cameroncooke/cameroncooke-skills): mines PR comments, threads and commits via `gh`. It scores acceptance (resolved thread, a "fixed" reply, a follow-up commit), dedupes against existing rules, records provenance, and writes `AGENTS.md`/`CLAUDE.md` only after the user picks. I saw this only in a search summary; the page didn't render. [listing](https://skillselion.com/skills/cameroncooke/cameroncooke-skills/pr-learning)

## Comparison

| Tool | What is shared | Where it lives | Consent & privacy | Paid? |
|---|---|---|---|---|
| AGENTS.md | Hand-written project instructions | Repo (git) | Git review only; no telemetry | Free / open |
| Agent Skills (SKILL.md) | Procedures (skills) | Repo or user dir | Git review only | Free / open |
| Claude Code marketplaces + managed settings | Plugins (skills, agents, hooks, MCP) | Org git repo; pushed by admin console / MDM | Admin-forced, users can't override; allowlists; OTel + Analytics API (install/invocation counts) | Marketplaces free; server-managed and analytics Team/Enterprise |
| claude.ai org skills | Skills | Anthropic (claude.ai org) | Owner provisions; peer sharing off by default | Team/Enterprise |
| Cursor Team Rules | Rules | Cursor dashboard | Admin sets enforced or optional | Team/Enterprise |
| Devin Knowledge | Knowledge items, suggested from chat feedback | Devin platform | Each suggestion human-reviewed before saving | Paid |
| CodeRabbit Learnings | Explicit preferences from PR chat | CodeRabbit DB (repo or org scope) | Optional admin approval delay; credential redaction; opt-out deletes; CSV export | Pro+ (free for OSS) |
| Greptile memory | Learned taste from reactions, replies, commits; suggested rules | Greptile (learned); repo `greptile.json`/`.greptile/` (explicit) | Not documented for learned memory | Paid |
| Cursor Bugbot learned rules | Rules from reactions, replies, human review comments | Bugbot dashboard (not git) | Auto-promote/disable; dashboard management | Paid add-on |
| Copilot Memory | Repo facts learned by agents, shared across coding agent, review, CLI | GitHub, per repo, 28-day expiry | On by default (Pro/Pro+); owner can delete; admin policy | Paid Copilot plans |
| Qodo auto best practices | Patterns from accepted suggestions | Repo wiki file | Editable file | Paid (OSS base) |
| Graphite Agent | Custom rules | Graphite dashboard | — | Paid |
| rule-miner / pr-learning (community) | Rules mined from sessions and/or PR reviews | Local; output to `CLAUDE.md`/`AGENTS.md` | Local; user approves each rule; `gh` calls GitHub | Free (MIT / OSS) |

## What none of them do

These are gaps observed across the sources above. They describe what the sources show, not whether habitlore should fill them.

1. **No hosted product learns from coding-agent sessions and from PR review together.** The review bots (CodeRabbit, Greptile, Bugbot, Copilot, Qodo) learn only from activity on the PR. Devin and Copilot Memory learn only from their own agent's runs. Only the small community skill rule-miner combines Claude Code transcripts with PR review history.
2. **Learned review taste stays in the vendor's store, usually in a format no other tool reads.** Bugbot's learned rules and Greptile's memory live in dashboards (the forum thread above asks for a git export). CodeRabbit exports only CSV. Copilot Memory expires after 28 days. Qodo is the exception: it writes a file to the repo wiki. None writes learned taste back as `AGENTS.md`/`CLAUDE.md`/`SKILL.md` that every harness reads. Greptile goes the opposite way: it indexes those files as input.
3. **None learns procedures (Workflows → Skills).** Every learner outputs rules, preferences or facts. None drafts a multi-step reusable procedure from repeated work.
4. **No team aggregation of derived knowledge from individuals' private work.** Team sharing is either top-down (admins push marketplaces or Team Rules) or happens on shared surfaces such as PRs. Nothing aggregates what each developer's agents learned privately (repeated Corrections, Workflows) into team-level candidates while keeping raw sessions on each machine. Claude Code's Analytics API counts plugin use; it does not share content.
5. **No per-item cross-source provenance at team scale.** CodeRabbit shows which PR comment created a learning, and pr-learning records provenance locally. No team tool shows that a candidate rule came from N people's sessions plus M review threads.
6. **Consent is per org, not per contributor.** Opt-outs and approval exist at the admin level (CodeRabbit approval delay and opt-out, Copilot policy, Cursor enforcement). None lets each contributor choose which of their derived items leave their machine.

## Open questions

- Does Greptile's MCP or plugin actually return the *learned* memory to coding agents, or only explicit rules? The changelog is ambiguous.
- Which plans include Bugbot learned rules, and can they be exported now (the forum request has no linked resolution)?
- Agent Skills: check each vendor's docs for exact skill directory paths before relying on cross-harness portability.
- Is PR-review mining through `gh` acceptable under habitlore's local-first promise, given that it reads from GitHub's API but sends nothing to a third party?
- How do rule-miner and pr-learning perform on real repos (precision, false positives)? Neither publishes evaluations.
- For Copilot Memory, how do the 28-day expiry and validation against current code compare with habitlore's Repeat Rule (60-day window)?
