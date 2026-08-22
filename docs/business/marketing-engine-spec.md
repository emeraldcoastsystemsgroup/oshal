# marketing engine — campaign strategy & automated implementation (specification)

> **Status: SPECIFICATION (proposed), 2026-08-22.** Nothing in this document is built unless marked
> **✅ exists**. Research date for all external pricing/benchmark figures: 2026-08-22 — every dollar
> figure is an external planning band (±30%), not a measured result, and vendor pricing must be
> re-checked the week a vendor is committed to. Implementation tracking:
> [BACKLOG — "Marketing engine"](../BACKLOG.md).

The job of this system: **take any built oshal product (the open core or a store app) and turn it
into traffic, users, and revenue** — repeatably, mostly automated, on a bootstrapped budget. New
products appear all the time; this is the standing machine they feed into, covering positioning,
target-market identification, pricing, channel campaigns, measurement, budget management, and the
improvement loop.

---

## 1. Ground rules (non-negotiable, before any architecture)

1. **Every outward-facing action is explicit opt-in, default OFF** (operator directive 2026-07-24).
   Publishing a post, sending a campaign email, changing an ad budget — each channel has its own
   consent row read directly with **no fallback**; no row = OFF. Delivery plumbing may be shared;
   the consent decision is never inferred from another setting.
2. **Approval-gated by default, standing authorization by exception.** Every publish/spend action
   goes through the existing confirm gate (HTTP 428 `confirmation_required`,
   [action-executor.ts](../../src/app/connectors/runtime/action-executor.ts) ✅ exists). A channel
   may graduate to autonomous operation only via a per-channel **standing authorization + daily
   cap + every-cycle ledger + auto-pause-on-failures**, exactly the shipped
   [series-pump.ts](../../src/app/series-pump.ts) pattern ✅.
3. **The only un-approved automatic actions are ones that reduce spend or risk**: pausing a
   campaign, stopping a scheduled post, halting on a budget breach. Increases always need a human.
4. **Honesty doctrine applies to marketing output hardest of all.** No invented metrics, features,
   or quotes; no competitive absolutes ("only/unique/no one else" — CLAUDE.md anti-drift rule 1);
   financial/performance figures carry a source and a paper/live posture label. The
   `POST_BEST_PRACTICES` block in [content-routes.ts](../../src/app/routes/content-routes.ts) ✅ is
   the voice contract: accurate, consistent builder voice, hook without bait-and-switch.
5. **Human-posted channels stay human.** Hacker News, Reddit, Product Hunt: bots draft and prep,
   a person posts and replies. HN guidelines ban AI-generated comments; most subreddits ban
   promotional automation; both norms are enforced socially and by ban. No sockpuppets, no upvote
   rings, no astroturfing, ever — platforms detect these and the reputational downside is fatal
   for an honesty-positioned product.
6. **Brand:** the product is **oshal** (lowercase) or "open swarm oshal"; canonical domain
   `oshal.ai`. Partner-app registrations always under `maintainer@emeraldcoastsystemsgroup.com`
   ([partner-app-registration.md](../partner-app-registration.md)).
7. **Boundary rules:** the marketing engine ships as a **store package** (Rule 0c) — core changes
   are limited to connector specs/actions and site-template edits. Connector credentials are
   consumed only inside schema-bounded deterministic operations (ADR-036/038 ✅); the model never
   sees a token. All LLM/image spend rides `recordCost` → `chat_tasks`/`oshal_cost_events` ✅ so
   marketing cost-of-goods is real, not estimated.
8. **Exclusion:** trading/finance tooling is personal-use only and is never marketed or sold
   (investment-adviser exposure). It does not enter this machine.

---

## 2. Operating model — two motions plus an intake

| Motion | Product | Goal | Engine |
|---|---|---|---|
| **A — adoption** | open core (free, stays free) | installs, stars, community, credibility | organic only: launches, content/SEO, communities, social. Zero ad spend — paid ads for a free self-hosted tool don't pay back. |
| **B — revenue** | commercial store apps (career first), later a hosted tier | signups → activation → paid MRR | full funnel: landing pages, lifecycle email, launches, then paid ads once tracking + unit economics are proven |
| **Intake** | every new product idea | decide if/where it enters A or B | the stage-gate in §11 — no spend before validation |

Motion A feeds Motion B: the open core is the top-of-funnel credibility engine (the "your keys,
your data, your box" story), and its audience — self-hosters, developers, AI tinkerers — overlaps
the buyers of the first commercial apps.

---

## 3. Architecture — the `marketing-engine` store package

One package in `oshal-applications`, suite `ai-productivity`, following the standard manifest
shape (`social/oshal-app.yaml` is the smallest complete model ✅). One bot per ticket-type
workflow (platform default); surfaces are views over the package's own owner-RLS store.

### 3.1 Bot roster

| Bot | Kind | Persona | Ticket type | Owns |
|---|---|---|---|---|
| **campaign-director** | inline concierge | extend `ai-lab/bot-personas/marketing-strategy-bot.yaml` ✅ | `campaign-review` | per-product campaign plan, weekly review, budget-change **proposals**, experiment registry |
| **market-analyst** | inline concierge | new | `market-research` | ICP cards (§10), competitor/pricing comparables, keyword research |
| **growth-analyst** | inline concierge | new | `growth-report` | weekly scorecard: pulls analytics/ads/email/GitHub data via deterministic reads, computes the funnel, flags anomalies |
| **content-marketer** | ✅ exists | `social-writer` (a0…0040) + Content Studio + comms bot | existing rails | drafts posts/articles/email; grades against `POST_BEST_PRACTICES` |
| **launch-coordinator** | inline concierge | extend `pr-communications-bot.yaml` ✅ | `launch` | launch checklists, drafts for human-posted channels, press/outreach templates, post-launch retro |
| **ads-operator** | dedicated bot-node | new | `ads-ops` | executes **approved** ad-platform mutations through schema-bounded provider intents; uploads server-side conversions |

Interactive asks (e.g. "draft me a campaign for X") go `BotNodeClient.execute` direct-sync;
scheduled work uses manifest `schedules:` (✅ wiring in
[swarm-app-schedule-wiring.ts](../../src/app/swarm-app-schedule-wiring.ts), executes only when
`ENABLE_AGENT_SCHEDULER=true`).

### 3.2 Rails reused verbatim (do not rebuild)

- **Publishing desk**: Switchboard Streams' 8-state machine
  (draft/in_review/approved/scheduled/published/rejected/failed/archived), Calendar's
  `startScheduledPostExecutor`, Compose's `publishTo` (X / LinkedIn / Facebook Page) and Stage
  fan-out ✅. Streams also ships an idempotent `POST /import` from the Content Studio and
  LinkedIn-assistant stores (unique `(user_sub, source, source_ref)` dedup) and a confirm-gated
  publish with a claim CAS so a double-fire cannot double-post — reuse both. The marketing
  engine is a *client* of this desk, not a second one.
- **Governed LinkedIn publish**: draft → grade → refine → approve → `create-post` connector action
  with audit row ✅ ([linkedin-assistant](../../src/app/routes/linkedin-assistant-routes.ts)).
- **Content research**: Content Studio topics feed (HN/Reddit/Lobsters/RSS, keyless) + draft/refine
  endpoints ✅.
- **Email**: `sendGmail` (the one MIME builder with the header-injection fence) for 1:1;
  `smtp-mailer.ts` for transactional ✅. Bulk/lifecycle goes to a real ESP (§5) — never Gmail.
- **Video/creative**: Video Studio, Creative Studio, storyboard image providers with
  `recordStoryboardImageCost` ✅ (copy Switchboard Compose's `POST /compose/image` call site).
- **Autonomous-loop template**: series-pump (standing authorization, daily cap, every-cycle run
  ledger including skips, auto-pause on consecutive failures, `notifyOperator` on delivery) ✅.
  Mirror its split exactly: loop engine kernel-resident, content plus the three spend switches
  (`enabled`, `standingAuthorization`, `dailyCap`) package-owned — and its import rule:
  **importing content never arms spend.** The pump's `POST /shows/import` writes premise/cast/
  style only and never sets the authorization switches; a campaign import must likewise never
  enable a channel, grant standing authorization, or set a cap as a side effect.
- **Cost capture**: `CostTrackingService.recordCost` / `recordCostOnce` ✅ — campaign-tagged task
  IDs so CAC includes our own generation spend.
- **Browser-node outreach**: [browser-task-dispatch.ts](../../src/app/browser-task-dispatch.ts) ✅
  for anything that needs a real browser — noting ADR-101 (browser swarm fleet) is design-only,
  so capacity is one desktop worker today.
- **Facebook**: the `meta-business` broker connector, not the legacy any-bot credential store.

### 3.3 New data model (package migrations, owner FORCE-RLS)

| Table | Purpose |
|---|---|
| `marketing_campaigns` | one row per product×motion campaign: ICP ref, message map, channels, status, budget envelope, target CPA |
| `marketing_events` | append-only funnel events (ts, source, utm fields, event, value, meta) ingested from analytics/ads/email APIs |
| `marketing_scorecard_weeks` | weekly rollup the growth-analyst writes and the surface reads |
| `marketing_experiments` | registry: hypothesis, ICE score, variable, window, verdict (§9) |
| `marketing_budget_ledger` | every budget change: proposed → approved(by) → applied, old/new values — the spend audit trail |
| `marketing_channel_authorizations` | per-channel opt-in rows (consent read directly, no fallback) + standing-auth caps |

### 3.4 UTM convention (mandatory on every bot-generated link)

`utm_source=<channel>` · `utm_medium=paid|social|email|community|referral` ·
`utm_campaign=<product>-<slug>` · `utm_content=<variant>`. Links into `oshal.ai` only; the
analytics side (§6) keys on these. Channels that penalize links (X charges ~$0.20/link-post;
some communities) get a plain mention + link-in-reply pattern instead.

---

## 4. Platform gaps this spec depends on (as of 2026-08-22)

Ranked; the first two are prerequisites for everything else.

1. **No web analytics exist anywhere.** `site/oswarm.ai` has no GA/Plausible/PostHog/Cloudflare
   snippet; repo-wide there is no UTM/conversion/campaign model. Fix in P0. The snippet must go
   into the **site generator templates** (`scripts/lib/product-site/render.js`), not the generated
   pages — the generator prunes and rewrites its four roots on every deploy.
2. **No analytics connector reads.** `posthog.yaml`/`mixpanel.yaml`/`amplitude.yaml` exist
   read-only ✅, but there is no Google Search Console, GA4, or Plausible connector spec at all.
3. **Connector write actions are nearly empty**: only `github`, `linkedin`, `todoist` declare
   `actions:` today. Needed: `mastodon` post action (spec exists read-only), a new `bluesky` spec
   + post action, and ads-platform provider intents (Google Ads / Microsoft Advertising / Meta
   CAPI) as deterministic fixed operations.
4. **Instagram/Threads publish is declared but unbound** in Switchboard (honest
   `skipped no_binding`) — acceptable; not a priority for a developer audience.
5. **Email at campaign scale** — nothing exists beyond Gmail/SMTP one-offs; an ESP connector with
   list + broadcast + suppression handling is new work (§5).

---

## 5. Services, keys, and lead times

API access itself is free on every row unless noted; you pay ad spend / usage. Register everything
under the business email. **Start the long-lead approvals (Meta review, LinkedIn Community
Management) in P0 even though they're not used until P1/P3.**

| Service | For | Auth/key | Cost (2026-08) | Lead time / friction |
|---|---|---|---|---|
| Cloudflare Web Analytics | site traffic (site already on CF Pages) | snippet token | free | same day |
| Plausible CE (self-host) **or** PostHog cloud | marketing-site + product analytics, funnel events API | self-host / project API key | ~$6/mo VPS · PostHog free ≤1M events/mo | days |
| GA4 + Measurement Protocol | **ads plumbing only** (smart bidding signals), not reporting truth | measurement_id + api_secret | free | same day |
| Google Search Console API | query/page SEO data, 16-mo history | OAuth scope on existing `google` connector | free | site verification, same day |
| GitHub traffic API | stars/clones/uniques for Motion A | existing PAT ✅ | free | done |
| **Google Ads API — Basic tier** | search ads automation: campaigns, budgets, keywords, offline conversion upload | developer token via API Center | free API | apply ≈5 business days; Basic (15k ops/day) is sufficient — Standard/RMF only matters for multi-tenant tools |
| Microsoft Advertising API | Bing mirror of Google campaigns | dev token, first-party | free API; CPCs generally lower | instant for own accounts |
| Meta Marketing API (Limited→Full) | FB/IG ads | app review; Full needs business verification + 500 API calls/15 days | free API | **2–6 weeks total — start early** |
| Meta Conversions API | server-side conversion events | system-user token (rotate ~90 days) | free | days; no business verification needed |
| Reddit Ads | dev-audience ads | **UI self-serve** (Ads API is partner-gated; CAPI is open) | $5/day floor; practical $25+/day | same day |
| X API (pay-per-use, 2026 model) | organic posting | app + pay-per-use billing | ~$0.015/post, **~$0.20/post with a link** [unverified rates — check console] | same day |
| LinkedIn Posts API (personal) | organic posting | `w_member_social` ✅ existing connector | free | **done** |
| LinkedIn Community Mgmt API | org-page posting | partner review | free | weeks–months; apply in parallel, don't block on it |
| Bluesky / Mastodon | organic posting to the OSS crowd | app password / instance token | free | same day; fully automatable |
| **Resend** | transactional + lifecycle email + broadcasts | API key + SPF/DKIM/DMARC DNS | free 3k/mo → $20/mo | same day + DNS propagation |
| Brevo (alternative/backup ESP) | campaign automation + CRM if Resend outgrown | API key | free 300 emails/day, unlimited contacts | same day |
| DataForSEO | programmatic keyword research | PAYG key | ~$50 min deposit; ~$0.05/keyword query | same day |
| Postiz (optional) | self-hosted social aggregator if direct APIs get heavy | self-host | $0 license | optional, later |

Rejected for now: SendGrid (free tier retired 2025-07), Mailchimp (automation paywalled,
contact-priced), LinkedIn ads (honest floor ≈$1.5–3k/mo — revisit only if a B2B enterprise motion
ever exists), TikTok (audit wall, wrong audience), Ayrshare ($149/mo solves approvals we can pass
ourselves).

---

## 6. Measurement framework

**Reporting truth = our own `marketing_events` + Plausible/PostHog. GA4 exists only to feed
Google's bidder.** The growth-analyst's weekly scorecard is the single artifact everything else
reads.

### Funnel per motion

| Stage | Motion A (core) | Motion B (apps) | External benchmark band (2025–26, ±30%) |
|---|---|---|---|
| Reach | site uniques, GH uniques, post impressions | landing uniques by UTM | — |
| Capture | installer downloads, stars, Discord joins | signup | landing-page → signup: ~8–12% (productled.com); sitewide low single digits |
| Activate | first successful `oshal-up` (proxy: install-page → docs progression until real telemetry consent exists) | first value action (career app: first tailored resume/apply) | ~25% within 72h is good (userpilot.com) |
| Convert | n/a (free forever) | paid subscription | freemium 2–5%; opt-in trial ~18% (chartmogul.com) |
| Retain | repeat doc/site visits, issue/PR authors | month-2 retention, MRR churn | — |

North stars: **Motion A — weekly installer downloads** (honest, measurable without telemetry);
**Motion B — weekly new paid conversions**. Everything else is diagnostic.

### Cost side

CAC per channel = (ad spend + tool spend + **our own LLM/image generation spend** from
`oshal_cost_events` campaign tags) ÷ conversions. Targets: LTV:CAC ≥ 3, CAC payback ≤ 12 months
(B2B medians run 16–18 months; an organic-first bootstrap should beat that decisively or the
channel is wrong). All benchmark posture: **external industry bands, paper — we have no live
track record and the scorecard never implies one.**

### Instrumentation invariants

- Server-side conversion mirroring from day one of paid: Google Enhanced/offline conversions via
  Ads API + Meta CAPI with event dedup and hashed identifiers (Event Match Quality ≥ 8 target).
  Small-budget smart bidding is signal-starved without this — it is the single highest-leverage
  paid-ads item.
- One primary conversion event per campaign (not five). If the real event is too rare for
  learning thresholds (Google wants ~15–30 conv/mo, Meta ~50/week/ad set), bid on a qualified
  upstream proxy and upload the true event for reporting.
- The scorecard **fails loud**: a week with a broken ingest shows "NO DATA", never a silently
  carried-forward number (same rule as the competitive scorecard).

---

## 7. Cadence

| Rhythm | What runs | Autonomy level |
|---|---|---|
| Daily | metrics ingest (analytics/ads/email/GitHub pulls); spend-guard check; queue health | fully automatic (reads + risk-reducing pauses only) |
| Weekdays | ≤1 post per authorized channel from the approved queue; engagement digest to operator | approval-gated → per-channel standing auth with daily cap |
| Weekly (Mon) | growth scorecard; campaign-review ticket: budget proposal, experiment verdicts, next week's content plan | scorecard automatic; every proposal human-approved |
| Biweekly | experiment evaluation (never shorter — B2B conversion lag makes weekly reallocation noise-chasing) | automatic analysis, human decisions |
| Monthly | ICP + pricing review; channel enter/exit recommendation; email deliverability check; unsubscribe/suppression hygiene | human decisions |
| Quarterly | strategy refresh; comparables re-scan; kill/keep per campaign | human |
| Per launch | launch checklist ticket (§8) | bot preps, human posts |

Content volume is sized for a solo operator's review bandwidth: ~2 technical articles/month,
~5 social posts/week total across channels, one email send/month to start. Quality over volume —
an honesty-positioned brand cannot afford slop, and review attention is the scarce resource.

---

## 8. Traffic playbook by channel (what actually brings visitors)

Ordered by expected yield for this specific product profile (OSS AI agent platform + dev-adjacent
apps):

1. **Launch events — the step function.** Show HN is the highest-leverage single action for an
   OSS agent platform: HN exposure averages ≈+121 GitHub stars/24h, +289/week, successful Show
   HNs drive 5k–50k visitors over 48h (arxiv HN→GitHub diffusion study). Norms: plain technical
   title, repo link, author-in-comments as engineer, no marketing tone; a flopped Show HN may be
   reposted later. Product Hunt is a credibility/backlink event, not a growth engine (Featured
   is editorially curated now). Reddit: r/selfhosted, r/opensource, r/SideProject, r/LocalLLaMA —
   human-posted, 9:1 give:ask ratio. Each new product gets a launch checklist ticket; each launch
   gets a retro with measured spike.
2. **Docs + SEO — the compounding engine.** The durable pattern that survives Google's
   scaled-content enforcement: programmatic pages backed by **real product data** (connector
   pages, app pages, benchmark outputs — the site generator already builds these ✅), technical
   deep-dives ("how the swarm dispatches 20 agents on one box"), and quickstart docs that answer
   questions directly. LLM-written topic farms are a spam-policy violation and get sites
   demolished — never. Cross-post to dev.to with canonical URLs. GSC data drives the keyword
   loop; DataForSEO fills gaps.
3. **AI-search presence (GEO).** Ship `llms.txt` (costs nothing; some engines read it), but the
   evidenced driver of AI-engine citations is third-party mentions — comparison articles,
   listicles, GitHub/HN/Reddit footprint — not on-page schema (citation studies found no
   schema correlation). Practical move: maintain honest comparison content and get oshal into
   others' "self-hosted agent platform" roundups.
4. **Social presence — steady, cheap, automatable.** LinkedIn personal (✅ live rail) for the
   builder narrative; Bluesky + Mastodon free and fully automatable, right audience; X within
   the per-post budget (link posts ~$0.20 — use sparingly). Facebook Pages via meta-business ✅
   where relevant (consumer-ish apps). All through the Switchboard desk with approval gates.
5. **Lifecycle email — owns the relationship.** Resend: welcome sequence on signup/waitlist,
   monthly changelog/founder note, product-qualified nudges (Motion B). List is first-party
   insurance against every algorithm change. SPF/DKIM/DMARC + suppression hygiene from day one.
6. **Community home base.** Discord (or GH Discussions) as the default "where users are" —
   norms for agent platforms in 2026. Low automation; high trust yield.
7. **Paid ads — last, gated, smallest surface that works.** Only for Motion B, only after
   server-side conversion tracking is live and a paid product exists. Entry order by
   fit-per-dollar: Google Search (intent capture; $1k/mo honest floor, $1.5–3k/mo to optimize
   at $8–14 SaaS CPCs) → Microsoft/Bing mirror (instant API, lower CPCs, ~10–20% of Google
   budget) → Reddit self-serve (dev audience, $25+/day practical) → Meta (only if a consumer
   app warrants it; $20–50/day/ad set for conversion campaigns). **One channel funded properly
   beats four starved ones.** LinkedIn ads: skip at this budget.

---

## 9. Budget management & the improvement loop

### Envelope

`MARKETING_BUDGET_MONTHLY_USD` — config → swarm env → demo default **0** (organic-only). Nothing
hardcoded. Sub-envelopes per channel live on the campaign row; the ledger records every change.

| Tier | Monthly | Unlocks |
|---|---|---|
| 0 | $0 | full organic machine (§8.1–8.6) — this is the default and is viable indefinitely |
| 1 | ≤$150 | tools: DataForSEO, X posting, VPS analytics, Resend paid |
| 2 | $500–$1,500 | ONE paid channel at its viable floor (usually Bing-first or Reddit; Google Search at the top of the band) |
| 3 | $1,500–$3,000+ | Google Search properly + Bing mirror + one experimental channel |

### Reallocation algorithm (weekly, proposal-only)

1. Compute trailing-28-day CPA and marginal CPA per channel from `marketing_events` + spend.
2. Respect floors: never fund a channel below its viable minimum (§8.7) — exit it entirely
   instead ("one channel done properly").
3. Shift ≤20% of the monthly envelope per week from worst to best marginal performer
   (epsilon-greedy: keep ~10% exploring). The platforms' own smart bidding owns *within-channel*
   optimization — we only move money *between* channels, the gap commercial tools leave open.
4. Learning-phase protection: no changes to any campaign <14 days old or <30 conversions,
   unless a guard fires.
5. Output = a `campaign-review` ticket with the proposed ledger diff. **A human approves; the
   ads-operator applies.**

### Guards (automatic, because they reduce spend)

- Daily spend > 1.5× plan → pause channel, notify.
- CPA > 3× target over 7 days → pause campaign, notify.
- Conversion-event ingest broken > 48h while ads run → pause **all** paid (bidding blind is the
  worst state), notify.
- Monthly envelope exhausted → everything paid pauses until the 1st or an explicit top-up.

### Experiment selection (how strategy improves)

- Registry (`marketing_experiments`): hypothesis, single variable, ICE score (impact ×
  confidence × ease, 1–10 each), window, verdict.
- Max **3 concurrent** experiments (solo review bandwidth); min window 2 weeks or the campaign's
  conversion-count threshold, whichever is later.
- Kill at <0.8× control; scale at >1.2×; otherwise extend once, then kill (no zombie tests).
- Weekly review ranks the backlog by ICE and replaces finished slots. Priority order when in
  doubt: message > audience > landing page > channel > bid strategy.
- Pricing experiments follow §12 rules (sequential cohorts, never simultaneous different prices
  on identical product).

---

## 10. Target-market identification (repeatable per product)

The market-analyst executes this 6-step worksheet per product; output is an **ICP card** stored on
the campaign row and consumed by landing copy, ad targeting, and channel choice.

1. **Problem census** — who demonstrably has the problem the product solves, from the product's
   own domain data, not intuition.
2. **Evidence mining** — GSC queries already reaching us; community threads (HN/Reddit search);
   competitor reviews (G2/alternativeto/Reddit) for named pains and vocabulary; GitHub
   stars/forks profiles for the core.
3. **Beachhead cut** — pick ONE segment that is (a) reachable through channels we can afford,
   (b) self-serve (no enterprise sales motion — standing constraint), (c) willing to pay
   evidence exists. Breadth is the enemy at this budget.
4. **ICP card** — role, trigger event ("just got laid off", "just got told to add AI agents"),
   watering holes, objections, willingness-to-pay evidence, disqualifiers.
5. **Message map** — pain → capability → **proof** (a real demo, a real number with a source).
   Claims inherit the honesty doctrine.
6. **Channel fit** — score §8 channels against where the ICP actually is; fund only the top 2–3.

Re-run monthly against fresh evidence; an ICP card older than a quarter is stale.

---

## 11. New-product intake (the stage-gate — no spend before validation)

Every new product idea enters here; this is what keeps "ideas all the time" from fragmenting the
budget.

| Stage | Spend allowed | Work | Gate to advance |
|---|---|---|---|
| 0 — validate | $0 | ICP card; landing section on oshal.ai (generator already builds per-app pages ✅); waitlist capture; one launch post (human) | ≥50 waitlist signups **or** ≥8% landing→signup in 30 days — else archive (page stays, campaign closes) |
| 1 — organic | tier-1 tools only | full §8 organic playbook; lifecycle email; activation instrumented | activation ≥20% and week-4 retention signal; pricing hypothesis from §12 |
| 2 — monetize | still $0 ads | paid plan live; sequential-cohort price test; server-side conversion tracking wired | ≥10 organic paid conversions and modeled LTV:CAC ≥ 3 |
| 3 — paid scale | tier 2–3 | one paid channel at floor; §9 loop governs | CAC payback ≤ 12 months at 90 days — else drop back to stage 1 |

Kill rule: two consecutive review cycles with no stage progress → archive. Archiving is cheap;
zombie campaigns are not.

---

## 12. Pricing (method, not numbers)

1. **Model default: hybrid** — low base subscription + a usage meter aligned to our marginal cost
   (LLM/execution). This is where the market moved (41–43% of SaaS hybrid in 2026, pure per-seat
   collapsing) and it matches our real cost structure. Free tier stays genuinely useful
   (open-core credibility).
2. **Initial point from comparables, not surveys.** Closest comp for a future hosted tier: n8n
   (self-host free; cloud ~€20/mo entry, execution-metered; enterprise ~$2–3k/mo). Agent-platform
   pattern: OSS free → managed cloud → enterprise (SSO/RBAC/audit) → usage meter. Per-app comps
   gathered by the market-analyst at stage-2 entry. Enter at/below the comp median — we are the
   unknown brand.
3. **Test sequentially, never simultaneously.** Cohort price changes for all new signups over a
   period are standard and safe; different prices for the identical product at the same time
   invites the 76%-feel-cheated problem. Package-level differences are the cleanest test. Honor
   any tested price for those who saw it; grandfather early users.
4. **Van Westendorp only at ≥100 respondents** with product context — until then it's theater;
   comparables + cohort tests carry the decision.
5. **Annual = ~2 months free**, introduced only after monthly churn is known.
6. Core stays free. **Never** paywall existing free capability (community trust is the moat);
   monetize new hosted value, new commercial apps, and support.

## 13. Monetization ladder (what pays, in order)

1. **Commercial store apps** (career first — decided; one GTM at a time) — subscription revenue,
   the primary engine.
2. **Hosted oshal tier** (later): base + usage, per §12. The n8n path.
3. **Support/services** — opportunistic; historically the largest *early* dollars for small OSS;
   doesn't scale, funds the bootstrap.
4. **Sponsorships** (GitHub Sponsors 0% fee, Open Collective ~10% fiscal host) — ecosystem
   accelerant, not income; realistic only past ~1k stars.
5. **App-store rev share** — future: third-party paid packages in the store. Copy the
   partner-friendly 2026 standard (Atlassian: 0% on first revenue up to a threshold, then
   15–25%; Apple/Google small-business 15%). Ecosystem-growth pricing first, take-rate later.

---

## 14. Implementation phases (done-when per phase; BACKLOG entry tracks)

**P0 — measurement foundation (prerequisite for everything).**
Analytics snippet into the site generator **templates**; Plausible CE or PostHog + Cloudflare Web
Analytics; UTM convention enforced in all link-emitting rails; GSC verified + connector read spec;
`marketing_*` migrations; scorecard v1. Start Meta app review + LinkedIn CM applications now.
*Done when: the weekly scorecard generates from real site data two weeks running, and a UTM-tagged
test link is visible end-to-end.*

**P1 — organic engine.**
Package scaffold (bots, manifest, surfaces); channel authorization rows + consent UI; content
pipeline Content Studio → Streams desk → approval → publish on LinkedIn ✅ + Bluesky + Mastodon
(+X within budget); llms.txt; Resend wired with welcome sequence + suppression handling; two
technical articles shipped.
*Done when: 4 consecutive weeks of cadence (§7) met entirely through approval-gated rails, zero
un-approved outward actions, list growing.*

**P2 — launch machine.**
Launch-checklist workflow; Show HN for the core (human posts); Product Hunt; community posts;
retro template. *Done when: core launched on ≥2 channels with measured spikes and a written retro.*

**P3 — paid ads (gated on: a paid product live + stage-2 exit + tier-2 budget set).**
Google Ads Basic token; campaign + conversion-upload provider intents for ads-operator; Meta CAPI;
Bing mirror; guards live. *Done when: 90 days of spend with server-side conversions flowing and
CAC on the scorecard.*

**P4 — optimization loop.**
Weekly reallocation proposals; experiment registry live; §9 guards proven by at least one real
auto-pause test. *Done when: 3 consecutive monthly cycles produce documented, approved
reallocation decisions.*

---

## 15. Research provenance & unverified items

Compiled 2026-08-22 from vendor documentation and practitioner sources (developers.google.com,
developers.meta.com, learn.microsoft.com, developers.facebook.com, plausible.io, posthog.com,
resend.com, brevo.com, dataforseo.com, chartmogul.com, productled.com, arxiv.org, plus ad-agency
benchmark aggregations — benchmark figures vary ±30% between sources). Known-unverified at spec
time: X pay-per-use exact per-unit rates; YouTube upload-quota change; Reddit's app-registration
gating details; "Bing ~30% cheaper" folklore; PMax minimum-budget guidance (practitioner, not
Google-stated). Re-verify each at the moment of commitment; none blocks P0–P2.
