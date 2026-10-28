# The demo runs the real pipeline on a scripted Model Provider and Embedder

`habitlore demo` writes a made-up history with the test fixture builders (Claude Code JSONL and a Cursor `state.vscdb`) into a fresh throwaway home directory, then runs the real scan, Analysis and `suggest` on it into that home's own store, and serves the dashboard on it. Analysis results come from a scripted Model Provider (an AI SDK mock language model) and a scripted Embedder that follow the dataset's script (`demoTopics` in `packages/fixtures/src/demo.ts`): deterministic, offline, no API key, no model download. The throwaway home is removed when the demo stops, and the person's own store, config and Harness data are never opened.

## Considered Options

- Ship a pre-built demo store file: no Analysis at startup, but it would drift from the store's migrations and the App's behaviour, and need regenerating on every schema change.
- Insert Analysis results straight into the store: skips the App's real rules (Repeat Rule, Targets, Evidence), so the demo could show states real use never reaches.

## Consequences

The demo always matches the current code, and the UI smoke test renders every screen on the same data. The demo's texts must stay in the topics the script knows; a new topic needs an entry in `demoTopics`. Building the demo takes well under a second.
