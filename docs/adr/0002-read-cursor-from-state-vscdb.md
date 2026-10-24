# Read Cursor Sessions from state.vscdb, not its JSONL transcripts

Cursor writes JSONL transcripts under `~/.cursor/projects/*/agent-transcripts`, which look like the obvious source, but they have no timestamps, no model and no tool results. The global `state.vscdb` SQLite database (`composerHeaders` for Sessions, `cursorDiskKV` `composerData:*` and `bubbleId:*` keys for messages) has all of these, so the Cursor Adapter reads that instead, always opened read-only.

## Consequences

The database can be several GB and is in WAL mode while Cursor runs, so reads must be read-only, streamed and incremental (by `lastUpdatedAt`). The key layout is undocumented and versioned (`_v` field), so the Adapter checks versions it knows.
