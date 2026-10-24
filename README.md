# sessionlore

> Agent monitors show what your agents **did**. sessionlore shows what to **teach them next**.

sessionlore reads your past AI coding sessions (Claude Code and Cursor to start), finds the workflows you keep repeating, and drafts skills and rules from them. You review every draft before anything is written to your agent's config.

**Status:** pre-alpha, built in public. Nothing works yet.

## How it will work

1. **Scan**: read finished sessions from Claude Code and Cursor into a local SQLite database.
2. **Analyze**: split sessions into tasks, label your corrections, and group similar tasks together.
3. **Suggest**: draft a skill or rule for each repeated workflow, citing the sessions it came from.
4. **Review**: accept, edit or reject drafts in a local dashboard. Accepted ones are written to `.claude/skills` or `CLAUDE.md`.

```bash
npx sessionlore scan
npx sessionlore serve
```

## Principles

- **Local first.** Your sessions stay on your machine. Only redacted text goes to the model provider you choose.
- **Bring your own model.** Any provider supported by the Vercel AI SDK, with your own key.
- **Nothing changes without your OK.** Every suggestion goes through the review queue.

## Roadmap

See [docs/v2-plan.md](docs/v2-plan.md) for what comes after v1.

## License

[MIT](LICENSE)
