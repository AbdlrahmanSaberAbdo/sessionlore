# Use Node's built-in node:sqlite, not better-sqlite3

sessionlore stores its data with the `node:sqlite` module built into Node 22+, rather than `better-sqlite3`. sessionlore is installed through `npx` by people trying it for the first time, and `better-sqlite3` is a native module whose install fails with compiler errors on machines its prebuilt binaries don't cover. Requiring Node 22+ is a smaller cost than a failed first install.

## Consequences

`node:sqlite` is newer and has a smaller API and ecosystem than `better-sqlite3`. Database access goes through one internal module so the driver can be swapped if `node:sqlite` falls short.
