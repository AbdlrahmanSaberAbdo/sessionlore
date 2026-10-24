# Compute embeddings locally; use the Model Provider only for language

Tasks are embedded with a small local model (transformers.js) and clustered on the user's machine. The Model Provider is used only for labelling Intents, naming Clusters and writing Suggestions. Not every Model Provider offers embeddings (Anthropic doesn't), users shouldn't need a second API key, and embedding locally means no extra text leaves the machine.

## Considered Options

- Model Provider embeddings: rejected because availability differs per provider and switching providers would invalidate stored embeddings.
- Clustering by LLM alone: rejected as expensive and unstable across runs.

## Consequences

The embedding model is downloaded on first use, not bundled, to keep the npm package small. Changing the embedding model invalidates stored embeddings and requires re-embedding.
