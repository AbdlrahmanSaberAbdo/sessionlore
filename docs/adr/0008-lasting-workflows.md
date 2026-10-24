# Workflows are lasting; re-clustering is explicit

Each Analysis assigns new Tasks to the closest existing Workflow, and only Tasks that fit none can form new Clusters. Workflows are never rebuilt from scratch automatically. Corrections per Task only measures improvement if a Workflow is the same Workflow before and after a Suggestion is Accepted, and re-clustering every run would split, merge and rename Workflows and break that history.

## Consequences

Workflows can drift from the best possible grouping over time. A full re-cluster is available on explicit request, and it must map old Workflows onto new ones so Accepted Suggestions and their before/after history keep pointing at the right place.
