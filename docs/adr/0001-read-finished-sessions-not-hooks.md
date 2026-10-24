# Read finished Sessions from Harness storage, not hooks

sessionlore reads Sessions after they end, straight from each Harness's own storage files, instead of capturing them live through hooks like agent monitors do. Finding Workflows doesn't need real time, Cursor has no hook system comparable to Claude Code's, and reading storage also covers all the history that existed before sessionlore was installed.

## Consequences

Data is only as fresh as the last Scan, and sessionlore depends on undocumented storage formats that a Harness update can change without notice. Each Adapter must fail loudly on unknown shapes rather than silently skip data. Live capture stays possible later (see `docs/v2-plan.md`).
