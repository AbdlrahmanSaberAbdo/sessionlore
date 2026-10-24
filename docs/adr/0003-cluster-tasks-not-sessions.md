# Cluster Tasks, not Sessions

A single Session often covers several unrelated goals, so clustering whole Sessions mixes unrelated work and hides repetition. Analysis first splits each Session into Tasks, and Clusters, the Repeat Rule and Workflows are all built from Tasks. A Task never spans Sessions.

## Consequences

Splitting Sessions into Tasks is an extra Model Provider call per Session and the main source of Analysis cost. Its quality caps the quality of everything downstream, so it needs its own evaluation fixtures.
