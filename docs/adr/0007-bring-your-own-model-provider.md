# Let users bring their own Model Provider through the Vercel AI SDK

habitlore calls whichever Model Provider the user configures (Anthropic, OpenAI, Google, Ollama or any OpenAI-compatible endpoint) with their own key, through the Vercel AI SDK, instead of being tied to Claude or shelling out to a Harness's CLI. It uses two slots: a cheap model for per-Session work and a strong model for writing Suggestions.

## Considered Options

- Run Claude Code headless (`claude -p`) on the user's subscription: no extra cost for Claude users, but ties habitlore to one vendor and one Harness being installed.
- A hand-written provider layer: more control, but no benefit for the effort.

## Consequences

Output quality varies by Model Provider, so prompts must be tested against more than one. Cost estimates must be computed per configured model.
