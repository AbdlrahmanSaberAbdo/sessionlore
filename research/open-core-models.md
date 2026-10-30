# How comparable developer tools draw an open-core line

Research for issue #38. Checked October 2026. Facts, not decisions. Licence facts come from each repo's `LICENSE` file as of this date unless noted.

## Survey

| Project | Core licence | Paid licence | Where paid code lives | What is paid | Notable backlash / incidents |
|---|---|---|---|---|---|
| **PostHog** | MIT | "PostHog Enterprise license": may be used in production only with a subscription and enough seats | `ee/` folder in the same repo. A read-only mirror with all proprietary code removed, `PostHog/posthog-foss` (MIT), is synced automatically | Hosted cloud (usage-based), plus enterprise and team features in `ee/`. Paid self-hosted licences are no longer sold | Feb 2023: dropped Kubernetes/Helm self-hosting (3.5% of users). Only the MIT Docker Compose "hobby" deploy remains, "without guarantee". Users were steered to Cloud |
| **GitLab** | MIT (CE / "GitLab FOSS"). Docs are CC BY-SA. All client-side JS is MIT | Proprietary EE licence (source-available) | `ee/` and `domains/<name>/ee/` in the same repo. `gitlab-foss` is the open-source-only downstream | Tiers based on who buys: if the likely buyer is an individual contributor, the feature is open source. Features for managers, directors and executives go in paid tiers (Premium / Ultimate). Also SaaS | Mostly avoided by public written stewardship promises: never move an open-source feature to paid, no artificial limits in CE, no delayed releases, always clear what is proprietary |
| **Cal.com** | AGPL-3.0 (2021–Apr 2026). Now **closed source** | Commercial licence for `ee/` (before Apr 2026). Now proprietary | Was `packages/features/ee` in the public repo. Production code moved to a private repo in Apr 2026 | Teams, Workflows, Insights, SSO, platform/API, hosting | Apr 14 2026: "Cal.com is going closed source", citing AI-assisted vulnerability discovery. The public repo became **Cal.diy** (MIT) with EE features and licence checks removed. Security fixes no longer flow to it automatically. Widely criticised |
| **Sentry** | FSL-1.1-Apache-2.0 (Fair Source). BSD-3 until about 2019, then BSL, then FSL from Nov 2023 | Same licence. No separate paid code: hosting is the product | Single repo. No `ee/` split | Hosted SaaS. Self-hosting is free, but "Competing Use" is barred for 2 years, after which each version becomes Apache-2.0 | Criticised as "not open source" (non-compete clause, not OSI-approved). Sentry answered by coining "Fair Source" and dropping the open-source label |
| **Supabase** | Apache-2.0 | None in the repo | No paid code in the public repo. Paid parts are platform services | Managed hosting. Self-hosting lacks branching, advanced metrics, managed backups/PITR, analytics and vector buckets, ETL, the Management API, and multi-project/org Studio | No major licence backlash. The line is "the platform", not a code fence |
| **Langfuse** (LLM observability, closest in domain) | MIT | Commercial `ee/LICENSE` | `ee/`, `web/src/ee/`, `worker/src/ee/` and `packages/shared/src/server/ee/` in the same repo | Since Jun 2025, only enterprise security and platform features: SCIM, audit logs, data-retention policies, plus support and hosting. SSO, LLM-as-judge evals, annotation queues, playground and prompt experiments were moved *into* MIT | Positive reception for moving features to MIT. Copyright notice now reads ClickHouse, Inc. |
| **HashiCorp (Terraform)** (cautionary) | MPL-2.0, changed to BSL-1.1 in Aug 2023 | — | — | Terraform Cloud / Enterprise | Spacelift, env0, Gruntwork and others forked it as **OpenTofu** under the Linux Foundation, followed by a registry ToS dispute and a cease-and-desist |
| **Redis / Elastic** (cautionary) | Relicensed to SSPL/RSAL in 2021–24, then AGPLv3 added back (Elastic Aug 2024, Redis 8 May 2025) | Commercial | — | Hosted / enterprise | Forks (Valkey, OpenSearch) and lasting distrust. Both partly walked the change back |

## Patterns

1. **Same-repo `ee/` folder under a source-available licence** (PostHog, GitLab, Langfuse, formerly Cal.com). The root `LICENSE` is MIT "except `ee/`". Optionally a FOSS mirror with `ee/` stripped (posthog-foss, gitlab-foss). This is cheap to run and stays transparent. The cost is licence checks in the code and contributors brushing against proprietary code.
2. **Everything open, and you pay for hosting** (Supabase, PostHog Cloud). There is no paid code to fence: the moat is operations, scale and multi-tenant features that only exist server-side.
3. **Delayed-open / Fair Source licence** (Sentry FSL, BSL). One licence for the whole repo with a 2–4 year non-compete, then it converts to Apache/MIT. Not OSI open source, and this draws criticism.
4. **Closed fork or relicense** (Cal.com 2026, HashiCorp 2023, Redis/Elastic). This is where most of the backlash sits, and it produced community forks each time.
5. **Public stewardship promises** (GitLab) and **moving features down into the open core** (Langfuse, GitLab Pages) lower distrust. The usual rule is that "Team/enterprise buyer" features are paid and "individual developer" features are free.

## Options for an MIT local CLI (habitlore)

- **A. Keep the CLI and dashboard MIT and make the paid layer a separate, closed hosted service** (team sync, shared skill library, org dashboards) in a separate private repo. The Supabase / PostHog Cloud shape. No licence change and no `ee/` in the public repo.
- **B. Add an `ee/` folder under a commercial licence in the same repo**, with the root `LICENSE` carved out (the PostHog / Langfuse / GitLab wording). Fits self-hostable Team features such as SSO, SCIM, audit logs and retention.
- **C. Move future code to FSL-1.1-MIT** (converts to MIT after 2 years). Already-released MIT code stays MIT. Expect "not open source" pushback.
- **D. Publish stewardship promises** (GitLab-style) alongside A or B: an explicit buyer-based line ("individual developer = MIT forever"), and never move MIT features to paid.
- **Constraint common to all**: code already released under MIT cannot be taken back. Any relicense only affects new versions, and forks of the MIT code remain possible (the OpenTofu / Cal.diy precedent).

## Open questions

- Will Team features need to run self-hosted (which favours B) or only as hosted cloud (which favours A)?
- Does the local-first, privacy pitch conflict with a cloud-only paid tier? Session data is sensitive.
- Do outside contributions need a CLA, or a DCO only, to keep relicensing and `ee/` options open?
- Would a FOSS mirror (posthog-foss style) be worth its upkeep at this project's size?

## Sources

- PostHog `LICENSE` and `ee/LICENSE`: https://github.com/PostHog/posthog/blob/master/LICENSE , https://github.com/PostHog/posthog/blob/master/ee/LICENSE
- posthog-foss mirror: https://github.com/PostHog/posthog-foss
- PostHog sunsetting Kubernetes (Feb 2023): https://posthog.com/blog/sunsetting-helm-support-posthog
- PostHog open-source self-host support: https://posthog.com/docs/self-host/open-source/support
- GitLab `LICENSE`: https://gitlab.com/gitlab-org/gitlab/-/blob/master/LICENSE
- GitLab stewardship promises and buyer-based tiering: https://handbook.gitlab.com/handbook/company/stewardship/
- Cal.com closed-source announcement (Apr 14 2026): https://cal.com/blog/cal-com-goes-closed-source-why
- Cal.diy repo (MIT): https://github.com/calcom/cal.diy
- Cal.diy relicense commit message ("Switch license from AGPL-3.0 to MIT"): https://github.com/calcom/cal.diy/commits/main/LICENSE
- Sentry `LICENSE.md` (FSL-1.1-Apache-2.0): https://github.com/getsentry/sentry/blob/master/LICENSE.md
- Sentry FSL introduction (Nov 2023): https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/
- FSL: https://fsl.software/
- Fair Source rebrand: https://blog.sentry.io/sentry-is-now-fair-source
- Critique: https://www.theregister.com/2023/11/24/opinion_column , https://lucumr.pocoo.org/2024/9/23/fsl-agpl-open-source-businesses/
- Supabase licence (Apache-2.0): https://github.com/supabase/supabase/blob/master/LICENSE
- Supabase self-hosting limitations: https://supabase.com/docs/guides/self-hosting
- Langfuse `LICENSE`: https://github.com/langfuse/langfuse/blob/main/LICENSE
- Langfuse open-sourcing product features (Jun 2025): https://langfuse.com/blog/2025-06-04-open-sourcing-langfuse-product
- HashiCorp BSL and OpenTofu: https://thenewstack.io/linux-foundation-adopting-terraform-fork-provokes-ire-of-hashicorp-ceo/ , https://www.thestack.technology/hashicorps-threats-to-a-terraform-fork-fell-flat-and-might-have-made-it-stronger/
- Redis back to AGPL (May 2025): https://www.theregister.com/2025/05/01/redis_returns_to_open_source/
- Elastic back to AGPL (Aug 2024): https://www.elastic.co/blog/elasticsearch-is-open-source-again
