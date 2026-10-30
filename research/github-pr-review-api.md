# What GitHub exposes for PRs and review comments

Research for issue #36. Facts only, no decisions. Checked 2026-10-30 against docs.github.com, the live GraphQL schema (introspection via `gh api graphql`), and sample calls on public repos (`cli/cli`, `rust-lang/rust`).

## Three kinds of PR feedback

GitHub keeps PR feedback in three separate places:

| Kind | What it is | REST | GraphQL |
|---|---|---|---|
| **Review** | A submitted verdict with an optional body | `GET /repos/{o}/{r}/pulls/{n}/reviews` | `PullRequest.reviews` → `PullRequestReview` |
| **Review comment** | A comment on a file or line in the diff. It usually belongs to a review and sits in a thread | `GET /repos/{o}/{r}/pulls/{n}/comments`, or `GET /repos/{o}/{r}/pulls/comments` for the whole repo | `PullRequest.reviewThreads` → `PullRequestReviewThread.comments` → `PullRequestReviewComment` |
| **Conversation comment** | A general comment on the PR's Conversation tab, not tied to a line | Issue comments API: `GET /repos/{o}/{r}/issues/{n}/comments`, or `/issues/comments` for the whole repo | `PullRequest.comments` → `IssueComment` |

- "Every pull request is an issue, but not every issue is a pull request." That is why conversation comments go through the Issues API. [REST issue comments](https://docs.github.com/en/rest/issues/comments)
- A review's `state` is one of `PENDING`, `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` (GraphQL enum `PullRequestReviewState`, from introspection). Reviews also carry `body`, `commit_id`, `user`, `submitted_at` (missing while pending) and `author_association`. [REST reviews](https://docs.github.com/en/rest/pulls/reviews)
- Email replies land on the Conversation tab and are "not part of a pull request review". [Commenting on a PR](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request)

## How a review comment links to file, line, commit and author

From the REST review comment object ([REST review comments](https://docs.github.com/en/rest/pulls/comments)):

- **File:** `path`. `subject_type` is `line` or `file`; a `file` comment has no line.
- **Line:** `line` is the last line of the range, `start_line` the first line of a multi-line range (otherwise null), and `side`/`start_side` are `LEFT` (old) or `RIGHT` (new). `original_line` and `original_start_line` keep the values from when the comment was made. `position` (offset into the diff) is deprecated: "This parameter is closing down. Use line instead."
- **Commit:** `commit_id` (current) and `original_commit_id` (the commit the comment was made on). `diff_hunk` holds the surrounding diff text, so the code being discussed can be recovered without fetching the commit.
- **Thread:** `in_reply_to_id` points at the top-level comment. Replies to replies are not supported. `pull_request_review_id` links the comment to its review.
- **Author:** `user` (may be null for deleted accounts) and `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`).
- **Body formats:** raw markdown `body` by default. The `text`, `html` and `full` media types add `body_text` and `body_html`.
- GraphQL `PullRequestReviewComment` has the same data (`path`, `line`, `originalLine`, `startLine`, `commit`, `originalCommit`, `diffHunk`, `author`, `authorAssociation`, `replyTo`, `pullRequestReview`, `body`/`bodyText`), and adds `outdated`, `isMinimized`/`minimizedReason`, `state` (`PENDING`/`SUBMITTED`), `reactions` and `userContentEdits` (edit history). From introspection.

## Suggested-change blocks

- A suggestion is plain markdown inside the comment `body`: a fenced block tagged `suggestion` holding the replacement text for the commented line or range. Docs mention the "line containing ```suggestion" and multi-line suggestions made by dragging across lines. [Reviewing proposed changes](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request)
- **Neither REST nor GraphQL has a structured suggestion field**, and there is no "applied" flag. The client has to parse the fence out of `body` and pair it with `line`/`start_line`/`diff_hunk`. Observed sample in `rust-lang/rust`: the body begins with "```suggestion\n<new code>\n```", followed by free-text reasoning.
- Applying a suggestion makes a commit. Each person whose suggestion is included becomes a co-author, and the person who applies it is the committer. [Incorporating feedback](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request) An applied suggestion can therefore be traced only indirectly, through `Co-authored-by` trailers in later commits.

## Resolved and outdated threads

- **Resolved** status exists **only in GraphQL**, on `PullRequestReviewThread`: `isResolved`, `resolvedBy`, `isCollapsed`, `isOutdated`, `path`, `line`, `originalLine`, `startLine`, `diffSide`, `subjectType`, `comments` (introspection). REST review comments have no resolved field. Only the PR opener or someone with write access can resolve. [Commenting on a PR](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request)
- **Outdated** means a later commit changed the commented lines. GraphQL exposes it as `PullRequestReviewThread.isOutdated` and `PullRequestReviewComment.outdated`. REST has no flag. Observed on an outdated thread in `cli/cli`: REST returned `line: null` and kept `original_line: 498`. This null-line signal is observed behaviour, not documented.
- Resolved is a human choice and outdated is computed from the code. They are independent: an outdated thread can be unresolved, and the reverse.

## How far back history goes

- No retention cutoff is documented for PR data. Review comments, reviews and issue comments stay as long as the repo and the PR exist. As a check, the oldest review comment returned for `cli/cli` (`sort=created&direction=asc`) is from 2019-10-08, the repo's first weeks.
- Repo-wide listing can be done incrementally: `GET /repos/{o}/{r}/issues/comments` takes `since`, `sort=created|updated` and `direction` [REST issue comments](https://docs.github.com/en/rest/issues/comments). `GET /repos/{o}/{r}/pulls/comments` accepted the same `sort`/`direction`/`since` parameters in testing. Pages hold at most 100 items.
- Deleted comments and comments from deleted users (`user: null` / "ghost") are gone or anonymised. GraphQL `userContentEdits` keeps edit history.

## Rate limits

REST ([docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):
- Unauthenticated: 60 requests/hour per IP.
- User token (PAT, or `gh` OAuth token): 5,000 requests/hour, shared with every app acting as that user.
- GitHub App installation: 5,000 to 12,500 per hour (15,000 on Enterprise Cloud).
- Secondary limits: at most 100 concurrent requests and 900 points/min for REST (a GET costs 1), plus content-creation limits.

GraphQL ([docs](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)):
- 5,000 points/hour per user (10,000 via Enterprise Cloud apps), and 2,000 points/min as a secondary limit.
- Cost ≈ (requests implied by the connections, assuming each fills its `first`/`last`) ÷ 100, with a minimum of 1. `first`/`last` must be 1 to 100, and one query may touch at most 500,000 nodes. Queries are killed after 10 seconds, which also costs extra points.
- The REST and GraphQL budgets are separate. The test account showed `core` 5000 and `graphql` 5000.

Rough scale: one PR with ≤100 threads × ≤100 comments fits in one GraphQL query. So a few thousand PRs per hour are reachable before hitting the user budget.

## Auth options for a local-first tool

- **Reuse `gh` CLI auth:** `gh auth token` prints the active account's token for a host and refreshes it when needed. [gh auth token](https://cli.github.com/manual/gh_auth_token) `gh auth login` stores the token in the system credential store, falling back to a plain-text file. `GH_TOKEN` overrides it. The minimum classic scopes gh asks for are `repo`, `read:org` and `gist`. [gh auth login](https://cli.github.com/manual/gh_auth_login) Nothing to register, and the token never leaves the machine. The tool inherits whatever broad scope the user gave `gh`.
- **Personal access token:** a fine-grained PAT needs only **Pull requests: read** for `/pulls/comments` and `/pulls/{n}/reviews`. `/issues/comments` accepts either Pull requests: read or Issues: read. [Fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) A classic PAT needs `repo` for private repos and nothing for public ones.
- **GitHub App (user access token via device flow):** suits CLIs, and device flow needs only the client ID, not a client secret. Tokens expire after 8 hours by default, with a 6-month refresh token. The token can reach only resources that both the user and the app can access, so the app must be installed on, or granted access to, the repo (org admins may have to approve). [User access tokens for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) Someone (the habitlore project) has to register and own the app. API calls still go straight from the user's machine to GitHub.
- GitHub Enterprise Server works through the same APIs on a different host (`gh auth token -h <host>`).

## GitLab and Bitbucket, briefly

- **GitLab** (merge request discussions API, [docs](https://docs.gitlab.com/api/discussions/)) is richer than GitHub here. Diff notes carry a `position` with `base_sha`/`start_sha`/`head_sha`, `old_path`/`new_path`, `old_line`/`new_line` and a `line_range` for multi-line notes. Notes have `resolvable`, `resolved`, `resolved_by` and `resolved_at`. **Suggestions are structured**: a `suggestions` array with `from_line`, `to_line`, `from_content`, `to_content`, `appliable` and `applied`. The markdown form is "```suggestion:-0+0". [GitLab suggestions](https://docs.gitlab.com/user/project/merge_requests/reviews/suggestions/)
- **Bitbucket Cloud** ([OpenAPI spec](https://api.bitbucket.org/swagger.json), [PR API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/)) is thinner. One endpoint, `/repositories/{ws}/{repo}/pullrequests/{id}/comments`, returns general comments, inline comments and replies together. `inline` has `path`, `from`/`to` (old/new line) and `start_from`/`start_to` for ranges, but **no commit SHA**. The other fields are `parent`, `deleted`, `pending`, and a `resolution` object (`type`, `user`, `created_on`) with a `/resolve` endpoint. The schema has no suggestion field and no outdated flag.

## Implications for habitlore

- A line-anchored review comment carries everything a Correction needs as Evidence: who (`user`, `author_association`), what code (`path`, line range, `diff_hunk`, `original_commit_id`), what they said (`body`), and a permalink (`html_url`). There is no agent Session behind it. The "agent did X" half of a Correction is the PR author's diff, not an agent turn.
- Suggestion blocks are the closest match to a typed Correction, because they hold a concrete "replace this with that". They have to be parsed out of markdown, and whether they were applied is not exposed.
- Resolved/outdated status needs GraphQL. Outdated hints that the code was changed in response, but does not prove it.
- Review bodies with `CHANGES_REQUESTED` and conversation comments have no line anchor, much like free-text Corrections in a chat.
- The tool can stay local-first by reusing the `gh` token or a fine-grained read-only PAT. No server or app registration is needed. Rate limits allow backfilling one active repo's history in about an hour.
- Bots (`user.type == "Bot"`, e.g. Copilot, CodeRabbit, dependabot) post review comments too and would need filtering, or separate handling.
- A provider abstraction would be lossy: GitLab adds structured suggestions, and Bitbucket lacks commit anchoring.

## Open questions

- Is it documented whether applying a suggestion resolves its thread? I found nothing. Needs an empirical test.
- Is the REST `line: null` on outdated comments a stable contract? It is undocumented. Prefer GraphQL `outdated`.
- Should replies within a thread (author pushback, reviewer clarification) count as Follow-ups or Clarifications, by analogy with the GLOSSARY?
- How should comments whose PR author was an AI agent (e.g. a Copilot or Claude PR) be told apart from human-authored PRs? Reviewer corrections of agent-written code are the closest analogue to a Correction.
- Which repos should be read: only ones the user authored PRs in, ones they reviewed, or all repos they can access?
