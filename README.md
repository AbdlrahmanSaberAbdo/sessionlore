# sessionlore

sessionlore reads your past AI coding sessions (Claude Code and Cursor to start), finds the workflows you keep repeating, and drafts skills and rules from them. You review every draft before anything is written to your agent's config.

**Status:** v0.1, early. Expect rough edges and breaking changes.

## How it works

1. **Scan**: read finished sessions from Claude Code and Cursor into a local SQLite database.
2. **Analyze**: split sessions into tasks, label your corrections, and group similar tasks together.
3. **Suggest**: draft a skill or rule for each repeated workflow, citing the sessions it came from.
4. **Review**: accept, edit or reject drafts in the terminal or a local dashboard. Accepted ones are written to `.claude/skills` or `CLAUDE.md`.

## Quickstart

Needs Node.js 22.13 or newer. Every command below also takes `--json` for machine-readable output; `npx sessionlore --help` lists them all.

### 1. Try the demo

```bash
npx sessionlore demo
```

Opens the dashboard on a made-up history. It needs no Model Provider, downloads nothing, and never reads or writes your own sessions or store. Add `--no-open` to only print the address, `--port N` to pick the port (default 4848), or `--json` to print the address and a summary of the made-up dataset as JSON. Press Ctrl-C to stop it.

### 2. Set up a Model Provider

Analysis and suggestions use a model you choose, with your own key. Create `~/.sessionlore/config.json`:

```json
{
  "modelProvider": {
    "provider": "anthropic",
    "cheapModel": "claude-haiku-5-5",
    "strongModel": "claude-sonnet-5-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

- `provider` is one of `anthropic`, `openai`, `google`, `ollama` or `openai-compatible`.
- `cheapModel` does the per-session work in `analyze`; `strongModel` writes suggestions.
- The API key comes from `apiKey`, the variable named in `apiKeyEnv`, `SESSIONLORE_API_KEY`, or the provider's own variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`). Ollama needs none.
- `baseURL` points at another endpoint; `openai-compatible` requires it (LM Studio, vLLM, OpenRouter and similar). Ollama defaults to `http://localhost:11434/api`.

Environment variables override the file, so you can also skip it entirely:

```bash
export SESSIONLORE_PROVIDER=openai
export SESSIONLORE_CHEAP_MODEL=gpt-5-mini
export SESSIONLORE_STRONG_MODEL=gpt-5
export SESSIONLORE_API_KEY=sk-...       # or OPENAI_API_KEY
# SESSIONLORE_BASE_URL=...              # optional
```

The same file also takes `projects` (`include` / `exclude` lists of project folders), `repeatRule` and `prices` sections. Cost estimates know the list prices of Anthropic's and OpenAI's models; for any other model, add `"prices": { "<model>": { "inputPerMillion": 0.5, "outputPerMillion": 1.5 } }` in US dollars, or the estimate shows "cost unknown".

### 3. Run it

```bash
npx sessionlore                    # same as: npx sessionlore run --since 30d
npx sessionlore run --since 2w     # or a date: --since 2026-09-01
```

Scans the sessions you were active in during the last 30 days (Claude Code and Cursor), analyzes them, drafts suggestions, and opens the dashboard on the review queue. Press Ctrl-C to stop it.

Before calling any model it shows one combined estimate and asks once. The analysis part is an estimate of the cheap model's use. The suggestion part is an upper bound: which workflows and repeated corrections show up is only known after the analysis, so it counts every one that could. `--yes` skips the question; without a terminal (in a pipe or CI) `run` stops before spending anything unless you pass `--yes`. Afterwards it reports what it found (sessions added and updated, tasks, workflows, near-workflows, repeated corrections, suggestions written) and the tokens and cost it used.

`run` also takes `--harness`, `--last N`, `--port N`, `--no-open` and `--json` (one JSON summary with the dashboard address). Without a Model Provider it still scans, then prints how to set one up and exits. With nothing new to analyze or suggest it skips the question and opens the dashboard. Ctrl-C during the analysis keeps finished work; run it again to pick up the rest.

## Step by step

The same flow, one command at a time.

### Scan your sessions

```bash
npx sessionlore scan            # every finished session on this machine
npx sessionlore scan --last 50  # only the 50 most recent
npx sessionlore scan --since 30d  # only sessions active in the last 30 days (or 2w, or since a date: 2026-09-01)
npx sessionlore scan --harness cursor  # only one tool: claude-code or cursor (repeat, or comma-separate)
npx sessionlore sessions        # list what was stored
```

Scan reads Claude Code's session files and Cursor's local database read-only and copies them into `~/.sessionlore/sessionlore.db`. It works without a Model Provider and sends nothing anywhere. `--since`, `--last` and `--harness` combine.

### Analyze

```bash
npx sessionlore analyze
```

Splits new or changed sessions into tasks, labels each message you typed (New Task, Correction, Clarification, Approval or Follow-up), and groups similar tasks into workflows. It shows a cost estimate and asks before calling the model; `--yes` skips the question. Ctrl-C stops after the current step and keeps finished work.

The first run downloads a small local embedding model (about 25 MB) into `~/.sessionlore/models`; later runs reuse it.

```bash
npx sessionlore workflows     # repeated workflows, and near ones
npx sessionlore workflow <id> # one workflow with its tasks
npx sessionlore corrections   # corrections you keep typing
npx sessionlore tasks         # every task with its labels
```

Workflows stay put between runs, so their history stays comparable. `npx sessionlore recluster` rebuilds the grouping from scratch on request, keeping each old workflow's id where its tasks went; when that leaves new groups to name, it shows the cheap model's estimated cost and asks first (`--yes` skips the question).

### Suggest

```bash
npx sessionlore suggest
```

Uses the strong model to draft a skill for each workflow and a rule for each repeated correction that has none yet. If you already have a matching skill or rule, the draft updates it instead. Like `analyze`, it shows a cost estimate and asks before calling the model; `--yes` skips the question.

### Review

```bash
npx sessionlore review         # pending drafts, their evidence, and a diff for updates
npx sessionlore edit <id>      # change a draft in $VISUAL or $EDITOR first
npx sessionlore scope <id> user           # install for every project (~/.claude)
npx sessionlore scope <id> project [dir]  # install for one project
npx sessionlore accept <id>    # write it
npx sessionlore reject <id>    # drop it; it won't be proposed again
npx sessionlore restore <id>   # undo an accept, putting back any file it overwrote
```

Skills are written to `.claude/skills/<name>/SKILL.md` and rules to `CLAUDE.md`, in the project or in `~/.claude`, depending on the draft's scope. Nothing is written until you accept. A draft that updates an existing skill or rule updates it where it is; moving such a draft to another scope with `scope` makes it a new skill or rule there instead, and `scope` says so.

`npx sessionlore stats` shows how often accepted skills get used afterwards.

### Use the dashboard

```bash
npx sessionlore serve
```

Opens the same data in your browser: an overview, a map of projects, workflows, tasks and sessions, and the review queue with accept, edit and reject. It listens on `127.0.0.1` only. `--port N` and `--no-open` work as in the demo.

## What leaves your machine

sessionlore has no server and no telemetry. It only talks to the network in two cases:

**Sent to your Model Provider** (only by `run`, `analyze`, `suggest` and `recluster`, and only after you configure one):

- the messages you typed in each session, never the agent's replies, tool calls, file contents or command output;
- task titles and correction messages, to name groups of similar tasks and corrections;
- for `suggest`, the messages of the tasks in a workflow or the corrections in a group, plus the text of an existing skill or rule it would update.

Every text is passed through secret redaction first: private keys, passwords in URLs, cloud and API keys, tokens, JWTs and other high-entropy strings become placeholders such as `[REDACTED:api-key]`. Run `npx sessionlore analyze --show-redacted <session>` to see exactly what would be sent for one session. Long messages are cut short.

**Downloaded once:** the embedding model, from Hugging Face, on the first `run` or `analyze`. Nothing is uploaded.

**Stays local:** your sessions, the store at `~/.sessionlore/sessionlore.db`, the embeddings (computed on your machine), the dashboard, and the skills and rules you accept. `npx sessionlore stats --export` prints aggregate numbers you can share by hand (`--anonymize` hides workflow names); sessionlore never sends them itself.

## Principles

- **Local first.** Your sessions stay on your machine. Only redacted text goes to the Model Provider you choose.
- **Bring your own model.** Any provider supported by the Vercel AI SDK, with your own key.
- **Nothing changes without your OK.** Every suggestion goes through the review queue.

## Roadmap

See [docs/v2-plan.md](https://github.com/AbdlrahmanSaberAbdo/sessionlore/blob/main/docs/v2-plan.md) for what comes after v1.

## License

[MIT](LICENSE)
