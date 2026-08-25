# ADR-131: Marketing engine ships as a consent-gated store package

Status: Accepted (2026-08-23) — decided overnight under operator instruction to make best choices
and record them; implementation landed with this ADR. Companion decisions: [ADR-132](132-public-site-analytics.md),
[ADR-133](133-outbound-marketing-connectors.md). Product spec:
[marketing-engine-spec](../business/marketing-engine-spec.md). Operator runbook:
[marketing-engine-runbook](../business/marketing-engine-runbook.md).

## Context

The operator commissioned the marketing-engine spec's "automated implementation": by morning the
platform should integrate the connectors and existing apps so the remaining human work is creating
accounts and approving campaigns. Constraints that shaped every choice:

- **Rule 0c**: applications ship from the store repo; the kernel stays app-free.
- **Operator directive 2026-07-24**: outward-facing actions are explicit per-user opt-in, default
  OFF, and a consent gate reads its own row with no fallback (the Haven near-miss rule).
- **One manifest = one ticketType/workflow** (loader as-built), inline bots omit `container:`,
  schedules execute only under `ENABLE_AGENT_SCHEDULER=true` (already on).
- The platform already has the rails the spec demands: the confirm-gated connector action executor,
  Switchboard's publishing desk, the series-pump standing-authorization pattern, `chat_tasks` /
  `oshal_cost_events` cost capture, and backlog-gated ticket dispatch.

## Decision

1. **One store package `marketing-engine`** (suite `ai-productivity`, v0.1.0) owning six owner-RLS
   tables: campaigns, channel authorizations, content, experiments, budget ledger (append-only
   spend audit), plus metrics events / scorecard weeks / run ledger. No core runtime code learns
   about marketing; core changes are limited to connector surface (ADR-133) and site analytics
   templates (ADR-132).
2. **Four inline concierge bots** (campaign-director `cadf…0001`, market-analyst `…0002`,
   growth-analyst `…0003`, launch-coordinator `…0004`) — package personas, no containers, no core
   registry entries. Reasoning rides `executeBotOrInline` (hosted/BYO brain ladder, cost-attributed
   to the caller); connector reads/writes happen in routes, never on a bot. The spec's
   `ads-operator` bot-node is **staged, not built** — it has no meaning until ad-platform accounts
   and API tokens exist (P3).
3. **Human approval is the front gate, `backlog` is the mechanism.** The weekly review schedule is
   a deterministic `service-route` handler (no LLM) that rolls up the scorecard and creates ONE
   `marketing-campaign` ticket per owner in `status: 'backlog'`. The workflow declares no
   `autoStart`, so nothing dispatches until a human flips the ticket to `approved` in the cockpit.
   The campaign-director then produces proposals — it cannot publish or spend.
4. **Per-channel consent table** `oshal_marketing_channel_authorizations` (channel ∈ linkedin,
   mastodon, bluesky, email): `enabled` and `standing_authorization` both `DEFAULT FALSE`; absent
   row = OFF; only strict boolean truth opts in; enabling standing authorization additionally
   requires an explicit `confirm: true` and a daily cap ≥ 1. Every publish attempt — including
   refusals — writes a run-ledger row (the series-pump every-cycle rule). Campaign/content
   **import never writes consent, cap, budget, or stage fields** (the video-pump `POST
   /shows/import` rule, enforced by a whitelist sanitizer with a regression test).
5. **Budget changes are proposal-only.** Bots and routes append `proposed` ledger rows; a human
   approves with `confirm: true` before anything is applied. The only automatic transitions
   allowed anywhere in the package are spend/risk-reducing (pause, skip, halt).
6. **Deterministic metrics ingest** (daily service-route, no LLM): Search Console via the
   `google-search-console` spec, PostHog via its existing read spec, GitHub traffic via an
   operator env token — each source fail-soft, recorded as `no_data` when unconfigured, never
   invented. The weekly scorecard marks per-source status and the surface renders NO DATA badges
   (the fail-loud scorecard rule).
7. **Existing apps are integrated as views, not couplings**: the ribbon embeds the kernel Content
   Studio and LinkedIn Assistant surfaces; Switchboard remains the publishing desk for X/Facebook
   and is reached by link, not by cross-package API dependency. `dependencies.apps` stays empty so
   no uninstall coupling is created.

## Consequences

- Morning operation needs only: account creation per the runbook, connector connects, per-channel
  consent toggles, and ticket approvals. Nothing posts, sends, or spends until then — proven by the
  default-deny gate tests and the run ledger.
- The clobber/collision rules are respected by construction: fresh agent UUIDs (`cadf…`), no shared
  bots, full capability arrays in the manifest.
- Paid-ads automation (Google/Meta/Bing operators, cross-channel reallocation execution) is
  deliberately absent until P3 gates pass; the budget ledger and proposal flow are already the
  interface it will land behind, so adding it will not change the human contract.
- A second marketing ticket queue (e.g. per-launch) would require a second package under the
  one-ticketType rule; the launch-coordinator works inside the single queue instead.
- Reversal: deactivate or uninstall the package (standard store lifecycle); tables are owner-RLS
  and dropped only on explicit `dropData` uninstall. Core keeps no marketing state.
