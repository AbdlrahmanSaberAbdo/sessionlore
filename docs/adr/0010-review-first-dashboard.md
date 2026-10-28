# The dashboard is review-first; the Mind map and Sessions list are removed

The dashboard is redesigned for the person who has just run `sessionlore run` and wants to know what it found and what to do. Its main job is deciding on Suggestions, so Home replaces the Overview and the separate Review queue: it opens on the Correction the person repeats most, then lists Pending Suggestions (Skills, then Rules) with one-line reasons, and opening one turns the page into a list-and-detail split. The navigation is Home, Workflows and Corrections. The Mind map and the Sessions list are removed; the Session viewer stays, reached through Evidence links. This departs from the v1 spec's Dashboard stories 70 and 72–74.

The look is the "Console" design: a developer tool that works from the keyboard, dark by default and light when the system asks for it. Blue marks Skills and the one primary action; amber marks Rules and Corrections, so colour always means something, and a shape (a square for a Skill, a dot for a Rule) carries the same meaning for anyone who can't tell the colours apart. Type is Geist, with Geist Mono only for code, paths and keys. The screens and their tokens are kept on a design canvas.

## Considered Options

- Keep the v1 screens and restyle them: five screens of equal weight left a first-run person without a starting point, and the Review queue did not say why a Suggestion existed.
- Keep the Mind map as a secondary view: it adds little to deciding on Suggestions, is the heaviest part of the UI (a graph library plus its own layout) and is hard to read at real size.
- Three prototypes (an inbox, a briefing, an evidence-first page) were compared on demo data; the chosen design mixes them. They are kept on the `prototype/dashboard-redesign` branch.
- A copy editor's look (paper, a blue pencil and a red pencil, Schibsted Grotesk) was built first and set aside: it read as plain and dated. Red for Corrections also read as errors. Two other directions, a pull-request-style review page and a one-Suggestion-at-a-time focus view, lost to Console: the first is slower to move through, the second hides the list.

## Consequences

The App gains read models that the old screens did not need: a Suggestion's reason and Evidence dates for Home, and a browsable list of Correction Clusters for the Corrections screen. The dashboard's fonts are bundled with it, never loaded from the network, because it runs offline on localhost. Switchable map views move to `docs/v2-plan.md` as a possible later screen.
