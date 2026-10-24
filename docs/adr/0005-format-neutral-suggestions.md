# Store Suggestions in a format-neutral form, with one Renderer per Harness

A Suggestion is stored as a neutral record (kind, title, trigger, steps, Evidence) rather than as a `SKILL.md` or `CLAUDE.md` file. A Renderer turns it into a specific Harness's file format when it is Accepted. v1 ships only the Claude Renderers, but the long-term goal is supporting many vendors, and storing Claude files directly would mean rewriting every stored Suggestion later.

## Consequences

The neutral form must cover what every target format needs, so adding a Renderer may require adding a field. Edits made in the review queue are made to the neutral form, not to the rendered file.
