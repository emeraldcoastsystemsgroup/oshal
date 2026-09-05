# Bug log

Interim, in-repo bug log. **System of record is Jira** (`your-domain.atlassian.net`), reached over
the existing external-tracker integration — the `jira` connector (`swarm-apps/connectors/jira.yaml`:
`jira-create-issue` / `add-comment` / `search-issues`) plus the push/pull feed-adapter pattern
(`src/features/ticketing/services/plane-sync-service.ts` and the `*-work-item-feed-adapter`s).
Jira is an **external** system: core capability + per-instance config, outside the swarm. Each entry
below is written Jira-ready (summary · type · priority · description · root cause · fix · prevention)
so it can be pushed straight in. *(Follow-up: a `jira-sync-service` sibling to `plane-sync-service`
would give full symmetric two-way sync; push-out + status-pull works on the connector alone today.)*

Statuses: **FIXED** = corrected in the working tree · **OPEN** = tracked, not yet done ·
**IN PROGRESS** = being worked now.

## Sweep status (2026-07-18, docs honesty)

**Tiers 0 + 1 COMPLETE — committed + pushed** (6 commits on `main`): `142d62bf` (absolutes / trading
figure / anti-drift rules / seeded bug-log), `cf197b73` (scorecard fail-loud guard), `eb9ab515`
(procurement freshness), `d0f0117c` (competitive-doc reinstatement), `c1bf1832` (connectors 45→307),
`47f14c42` (Workflow Studio Publish-to-runtime + site self-healing).

**Remaining — next session picks up here:**
- **Tier 2:** counts generator (BUG-9 — **EXTEND `scripts/site-apps-catalog.js`**, the existing
  provider/app gate; do NOT build a competing script); ADR status drift (BUG-10 — **coordinate**, a
  bot is already stamping supersessions, e.g. `d9f99996`); evidence-generator honesty (presence-vs-live
  labeling, BUG-4 residual).
- ~~**Tier 2 — architecture-doc live-feature under-claims**~~ — **DONE 2026-08-02.** All three named
  under-claims are folded into `platform-feature-catalog.md` and corrected at their source:
  - **personal-graph** — `connectors-and-graph-architecture.md` claimed it "has no import in
    `server.ts` and no ingest scheduler … exercised only by unit tests" and that a persistent
    `PgGraphStore` was "not yet built". Both routers are mounted `requiresAuth` behind
    `PERSONAL_GRAPH_ROUTES`, ingest pulls live through the ADR-065 spec client, and `PgGraphStore`
    ships owner-scoped (migrations 057 + 094). Corrected in place, and the capability was **added to
    the catalog as §41** with its three genuine residuals (Pg store built-but-unwired, no scheduler,
    not surfaced to Jarvis).
  - **Token Chase** — catalog §29 carried "Caveat — not wired to HTTP … no savings-report API yet";
    `server.ts` mounts `/api/token-chase` with `requiresAuth` and the routes expose the step-3
    variant path plus `GET /savings`, `GET /savings/report` and `POST /runs/:id/savings`. Rewritten
    as steps 3–4b.
  - **A2A gateway** — absent from the catalog entirely while shipped; **added as §40** (agent card
    `0.3.0`, JSON-RPC `message/send`/`tasks/get`/`tasks/cancel`, ticket on the ADR-083 rails under
    `a2a:<agentId>`, outbound `a2a` harnessType, default-off + fail-closed inbound ceiling), with
    the Plan-F deployment residual kept visible.
  - Also folded in the same pass: the dated **"Go-live pending (Music + Movies, 2026-06-20)"**
    banner (both apps carved to the store — a core rebuild is no longer their deploy path; only the
    concierge round-trip survives as a real residual) and the **Unreal MCP "vendored"** line
    (de-vendored 2026-07-23; nothing Unreal is tracked in this repo).
- **Tier 3:** orphaned retired-feature docs (BUG-11), `docs/k8/` shipped-path (terraform),
  CLAUDE.md's stale extension-guide citation, stale infra facts (any-bot:latest, ports,
  Keycloak), index hygiene.

**Verified counts (for BUG-9 — don't re-derive):** 34 manifests · 307 connectors · 101 personas ·
~113 numbered ADRs (114 files) · **42 providers (CONFIRMED — `site-apps-catalog.js` already counts
this; reader's "41 off-by-one" flag was itself wrong)** · ~44 registry bots · 49 compose containers
(~40 bots). Worst drifts to fix: `platform-feature-catalog.md` ("28" **and** "63" ADRs on one page),
whitepaper/reference/stem-cell ("26 bots / 68 personas / 9 apps / 22 providers").

---

## BUG-1 — Documentation honesty drift across the corpus
- **Type:** Bug · **Priority:** High · **Status:** IN PROGRESS (tiered remediation)
- **Discovered:** 2026-07-18, via a 6-bucket adversarial docs audit (guides/architecture, ADRs,
  marketing+competitive, evidence generators, runbooks/ops, site+public-repo).
- **Summary:** The docs are "close but not up to date" — and drift runs in **both** directions:
  more often *under-selling* shipped capability than over-claiming it, with a small cluster of
  genuinely dangerous over-claims on public collateral.
- **Root cause (3 systemic):** (1) counts and status lines are hand-typed and owned by no
  generator, so they rot when code moves; (2) a snapshot culture — assets/whitepaper/ADR-index are
  point-in-time captures never reconciled after ship, so they now concede features that shipped;
  (3) the 2026-07-17 honesty study over-corrected on competitive axes (conceded real
  differentiators) while never scrubbing "only/nobody-else" language out of the whitepaper/site.
- **Fix:** the tiered remediation tracked as BUG-2…BUG-11 below, plus the durable guardrails —
  the CLAUDE.md **anti-drift rules** and the **counts generator** (BUG-9).
- **Prevention:** CLAUDE.md "Anti-drift rules" (no absolutes; counts generated; ship→reconcile
  collateral; both-directions sweep; sourced financial figures; scorecard fails loud).

## BUG-2 — "only / nobody-else / no-other" absolutes on public collateral
- **Type:** Bug · **Priority:** High (public-facing) · **Status:** FIXED
- **Where:** `docs/WHY_OSHAL.md` (×3), `docs/OSHAL-WHITEPAPER.md`, `docs/assets/oshal/OSHAL-overview-deck.md` (×2), `site/oswarm.ai/index.html` — some re-claimed an axis the study explicitly **refuted**.
- **Fix:** restated each as the true category/architecture claim (harness-layer neutrality; a hosted
  single-vendor product structurally can't) with no superlative. Public `open-shal` copies + the
  whitepaper PDF regenerate from HEAD via the baseline scrub — **needs a baseline regen before public launch.**

## BUG-3 — Unsourced "~4%/month over the market" trading figure on a real-money framing
- **Type:** Bug · **Priority:** High (liability) · **Status:** FIXED
- **Where:** `site/oswarm.ai/index.html` app-spotlight (trading). Posture is paper-only
  (blank `TRADING_RISK_POSTURE_LIVE`); the lab page itself says "not a track record."
- **Fix:** removed the return figure; replaced with the honest paper-first / double-opt-in / no-live-track-record statement.

## BUG-4 — Competitive scorecard silently decayed; nightly can't detect it
- **Type:** Bug · **Priority:** High · **Status:** IN PROGRESS — fail-loud guard **SHIPPED + verified** (`cf197b73`; catches the real 87/6-missing decay). Honest board re-run did **not** complete (background job stopped, no record). Board number still needs a finished `node scripts/evidence/nightly-refresh.mjs` on the healthy stack (Postgres/Chroma up 13h), then commit the fresh `competitive-readiness-*.json`. Do NOT commit the degraded 87 — it's an infra-flake reading, not a real regression.
- **Where:** `docs/evidence/*2026-07-18*` (disk = 87, 6 categories on the 75 floor) vs the committed
  board (95, all-closed); `scripts/evidence/nightly-refresh.mjs` exits 0 with **no floor/alarm** when
  proof generators fail (Postgres/Chroma dropped mid-run).
- **Fix (planned):** add a floor/decay alarm to the nightly (compare vs last committed board, exit
  non-zero / notify on drop); commit the honest number after a clean re-run on a healthy stack;
  block publish when uncommitted decay exists. Do **not** commit the stale 95 as current.

## BUG-5 — Procurement security packet cites ~26-day-old evidence as current proof
- **Type:** Bug · **Priority:** Med-High (buyer-facing) · **Status:** FIXED (freshness banner + regenerate-before-send requirement added)
- **Where:** `docs/enterprise/procurement-security-packet.md` hard-cites June 22–23
  evidence; artifacts stamp `Proof-Tier: live` when most gates are `fileContains` regex.
- **Fix (planned):** cite by "latest"/prefix or a dated as-of note; regenerate from newest run; label
  per-gate proof tier instead of a blanket "live."

## BUG-6 — Workflow Studio Publish→runtime under-claimed as roadmap/design-time
- **Type:** Bug · **Priority:** High (under-claim) · **Status:** FIXED (corrected ~18 spots across README, ROADMAP, framework-guide, CLAUDE.md, addon-guide, assets ledger, code README; site Shipped list upgraded + self-healing loop added; verified vs compiler ground truth — single-shot/staged/graph all shipped, only NL-agent-authoring remains roadmap)
- **Where:** `docs/framework-developer-guide.md` (the "honest truth matrix"), `README.md:153`,
  `ROADMAP.md:85,98`, whitepaper, and the whole `docs/assets/oshal` bundle — `messaging-kit.md:44`
  even tells reps to *avoid* claiming it. Publish is **live**: `src/app/routes/swarm-app-routes.ts:189`,
  compiler supports `single-shot|staged|graph` (branches/parallel), NL→canvas wired.
- **Fix (planned):** rewrite to as-built (linear + graph + NL-canvas shipped; only NL-composes-new-agents remains roadmap).

## BUG-7 — Competitive doc conceded two real differentiators (strawman-of-self)
- **Type:** Bug · **Priority:** High (under-claim) · **Status:** FIXED (added "What was under-sold": reinstated harness-layer neutrality + codepacking with caveats; corrected the wrong "cut the routing claim from the site" remediation)
- **Where:** `docs/business/competitive-claims-honest.md:26-27` — refuted weakened
  versions of its own claims: (a) "model routing" (category error — OSHAL routes across **harnesses/agent
  runtimes**, not just models: `harness-adapter.ts:36`), (b) never addressed **codepacking**. Its
  remediation ("cut the routing claim from the site") is also **wrong** — the site's harness-routing claim is true.
- **Fix (planned):** reinstate harness-layer neutrality + codepacking under "what survived" (with the
  honest caveats); delete the "fix the site down" instruction.

## BUG-8 — Connector breadth understated 6.8× (45 documented vs 307 specs)
- **Type:** Bug · **Priority:** Med · **Status:** FIXED (ran gen-connector-docs.ts → catalog + 262 new per-provider docs regenerated at 307; audit all-PASS)
- **Where:** `docs/connectors/README.md`, `docs/architecture/connectors-and-graph-architecture.md`
  say 45; `ls swarm-apps/connectors/*.yaml` = 307. Jira/Salesforce have specs, no doc page.
- **Fix (planned):** re-run `scripts/connectors/gen-connector-docs.ts`.

## BUG-9 — Hand-typed counts drift and self-contradict
- **Type:** Bug · **Priority:** Med · **Status:** OPEN (root-cause fix = counts generator)
- **Where:** `docs/architecture/platform-feature-catalog.md` states both "28 ADRs" and "63 ADRs" on
  one page; whitepaper/reference/stem-cell say 26 bots · 68 personas · 9 apps · 22 providers.
  Verified: 34 manifests, 101 personas, 44 registry bots, 114 ADRs, ~40 containers, code-server 8444.
- **Fix (planned):** write a generator that derives "By the Numbers" from the tree (settles the
  41-vs-43 provider ambiguity authoritatively); replace literals with generated values.

## BUG-10 — ADR status drift (~20 ADRs)
- **Type:** Bug · **Priority:** Med · **Status:** OPEN
- **Where:** `docs/adr/` — worst: ADR-005 "Cline is the ONLY LLM path" still Accepted (reversed
  same-day by 020, superseded by 033); unrecorded supersessions (006→034, 016→017, 018→019,
  004→019/024, 050→083, 003→OIDC); ADR-038 "Proposed" but is the governing built architecture;
  duplicate ADR-090; README index "reconciled 07-05" but rows run to 07-18.
- **Fix (planned):** stamp Superseded-by / correct statuses; renumber the duplicate 090; re-reconcile the index.

## BUG-11 — Orphaned retired-feature docs read as live
- **Type:** Bug · **Priority:** Med · **Status:** OPEN
- **Where:** Little Monsters (carved to another repo, ADR-085) still framed as in-repo across
  stem-cell/whitepaper/`deployment-models` demo link/backlog/cloudflare runbook; Jobs-2026 cutover
  runbook; Enrique store refs (purged); paused remote-apply. Also `docs/k8/` documents the dead
  `any-bot-k8s` workspace while the shipped `deploy/terraform` path is undocumented;
  `CLAUDE.md` cited an archived extension guide as authoritative.
- **Fix (planned):** add carved-out/completed/paused banners or relocate; document the shipped k8s
  path; repoint the archived citation.

## BUG-12 — Cockpit surfaces render their own hardcoded palette instead of the active theme
- **Type:** Bug · **Priority:** Med · **Status:** FIXED 2026-08-10 (gate shipped)
- **Discovered:** 2026-08-09, operator, on **Intelligent Processing** — the pane renders a dark-navy
  header and body inside a light-themed cockpit, so the surface visibly does not belong to the shell
  around it.
- **Summary:** An embedded cockpit surface is supposed to take its colours from the framework theme
  the user picked. A large share of surfaces instead ship a bespoke `:root` palette of hardcoded hex
  values and link no theme source at all, so they only look correct in a dark theme, by accident, and
  clash in the other ten.
- **Where (verified, not inferred):** `src/pages/intelligent-processing/index.html` links exactly one
  stylesheet — `/shared/ui/css/surface-glass.css` — and **omits `/shared/ui/css/surface-themes.css`**.
  It then defines its own `:root` with `--bg: #070d1c`, `--text: #e8eef7`, `--line: #22324f` and
  siblings; its 22 `var(--…)` references resolve to that local palette, never to framework tokens.
  Repo-wide, **25 of 49 surface HTML files link no theme source**. Excluding the cockpit shell
  (`src/pages/cockpit/index.html`, which legitimately owns the theme and links `css/themes/*` itself)
  and the standalone public pages (`api/index.html`, `api/privacy.html`, `api/terms.html`), roughly
  twenty of those are ribbon-reachable surfaces with the same defect — among them Eval Wall, Run
  Trace, the Health/Ops/Queue/Mesh dashboards, RAG Center, Task Explorer, Process Lab and Swarm Control.
- **Root cause:** a **half-finished remediation, not an unknown problem.** `surface-themes.css` was
  built precisely for this — its own header records that "28 of 37 surfaces hardcoded their own dark
  palette and consumed ZERO framework tokens, so they only 'worked' in dark by accident and broke in
  the other ten themes." Twenty-four surfaces were converted; the rollout stopped there, and nothing
  fails when a new or unconverted surface ships without a theme source. Every surface added since
  inherits the old habit because the bespoke-palette file is the nearest copy-paste neighbour.
- **Fix:** for each affected surface, link `/shared/ui/css/surface-themes.css`, carry the theme
  through on `<html data-theme=…>` from the shell's stored choice, and replace the hardcoded `:root`
  block with aliases onto framework tokens. `src/api/token-chase.html` is the reference
  implementation of the whole pattern. No layout change is required — only the colour source.
- **Prevention (guard-per-fix):** a unit gate that enumerates the surface HTML files and fails when
  one links neither `surface-themes.css` nor `cockpit/css/themes/*`, and that flags a bare hex colour
  in a `:root` block. Without it this regresses on the next surface anyone adds — which is exactly
  how it got to twenty.

### Resolution (2026-08-10) — and two ways the write-up above was wrong

**Fixed.** 19 surfaces were given a theme source (the `surface-themes.css` link, a default
`data-theme` on `<html>`, and the cockpit-theme inherit script), and **315 hardcoded colours across
37 files** were remapped onto framework tokens by semantic role — a near-black page to
`--bg-primary`, a panel to `--bg-secondary`, borders to `--border-color`, bright/dim copy to
`--text-primary`/`--text-secondary`, and the blue/green/amber/red hues to `--accent-primary` and the
`--status-*` set. Alias names were left untouched, so no surface needed layout changes. Guard:
`tests/unit/surface-theming.spec.ts`, mutation-proved on all three properties (theme source removed,
hex returned to `:root`, `data-theme` removed — each goes red; restore goes green).

**Correction 1 — the count was over-stated in one direction.** "Roughly twenty ribbon-reachable
surfaces with the same defect" ignored a third mechanism: `eval-wall`, `feeds` and `governance`
carry a parent-token mirror script that copies the cockpit's computed tokens onto their own aliases,
so those three already followed the theme *when embedded* and were only broken standalone. The
genuinely broken set was ~16, not ~20.

**Correction 2 — and under-stated in another.** The scan behind the original entry counted hex in
HTML only, so it missed the surfaces whose palette lives in a sibling `.css` (`swarm-control.css`
alone held 53). It also assumed the 24 already-converted surfaces were done; the gate immediately
proved otherwise — most had taken the theme link but kept hardcoded accent and status colours, so
they were half-converted. That is the real lesson: **the earlier rollout stopped without a gate, so
"converted" was never verified — and a partially converted surface looks identical to a finished one
until something checks.** The gate is the durable half of this fix; the remap is the one-off half.

## BUG-13 — Identity Hub's expired-login signal is dead UI (the field is never sent)
- **Type:** Bug · **Priority:** Med · **Status:** FIXED 2026-08-12 (PR pending merge — see Resolution)
- **Discovered:** 2026-08-09, by the adversarial as-built review while writing
  [the Identity Hub guide](../guides/identity-hub.md) — the reviewer could not make the documented
  "Reconnect an expired login" affordance appear, and traced it to the API rather than the surface.
- **Summary:** Identity Hub's reason to exist is telling you which connected account has gone stale.
  That signal can never fire. The surface reads a per-connection `expired` flag that the API does not
  emit, so the flag is `undefined` — falsy — everywhere it is used.
- **Where (verified both ends):** `src/app/routes/connector-response-helpers.ts` builds each
  connection as `{ connectionId, label, account, tenantId, isDefault }`; the file contains no
  `expired` / `expiry` / `expiresAt` key at all. The store surface
  `oshal-applications/identity/tools/identity.html` consumes `c.expired` in four places — the
  per-provider `anyExpired` (`:606`), the `· expired` account marker (`:610`), `countExpired`
  (`:632`) feeding the **Need attention** summary tile (`:642`), and the card's Reconnect-pill
  decision (`:650`). Net user-visible effect: **Need attention always reads 0**, the red Reconnect
  pill never renders, the `· expired` marker never renders, and the **Needs attention** filter
  catches only connected-but-unconfigured providers. A user whose Google token actually expired gets
  no indication on the one screen built to show it.
- **Not a wider outage:** those four are the only consumers of a per-connection `expired` flag in
  either repo. The Access Review path computes expiry itself from the stored `expiry` value rather
  than trusting the list response, which is why the same page can report a stale account in the
  review while showing zero in the tile. *(This entry originally called the review path
  "unaffected". It is not — see the Resolution: it was wrong in the opposite direction.)*
- **Root cause:** the list response is a deliberately narrow, credential-free projection (its header
  says "status and account selectors only"), and expiry was never added to that allowlist when the
  Hub was written against an assumed field. Nothing fails when a surface reads a key the response
  does not carry, so it shipped looking correct.
- **Fix:** derive expiry in `buildConnectorListResponse` from the stored token expiry — a boolean
  (and optionally an ISO timestamp), never the token itself — keeping the projection credential-free.
  The surface then needs no change.
- **Prevention (guard-per-fix):** a unit assertion that the connector list response carries the keys
  the shipped surfaces actually read, so a projection that drops a consumed field goes red instead of
  silently rendering a zero.

### Resolution (2026-08-12) — and the fix this entry proposed was itself half wrong

`buildConnectorListResponse` now projects a per-connection `expired` boolean, so all four consumers
light up and the surface needed no change, as predicted. But the fix as written above — *"derive
expiry in `buildConnectorListResponse` from the stored token expiry"* — would have shipped a worse
bug than the one it closed, and the difference is the whole point of this entry.

**`expiry < now` is not what "expired" means.** `getValidAccessToken` renews an access token
silently whenever a refresh token is stored, so a lapsed access token on a refreshable grant is the
ordinary steady state — a Google access token lives one hour, so a healthy Google connection is
"past expiry" for most of its life. Checked against the live store before writing any code: **9 of
24 connections had a past expiry, and all nine carried a refresh token.** The naive rule would have
turned a tile that always read 0 into a tile that read 9, on a deployment where nothing was wrong.
A tile that cries wolf nine times is worse than a dead one, because a user acts on it.

The shipped rule is `isConnectionExpired` in `connector-tenancy.ts`: lapsed **and** unrenewable —
the exact case where `getValidAccessToken` hands the stale token back unchanged and the provider
rejects it. It reads 0 on this deployment, which is the correct answer.

**The Access Review was not "unaffected" — it already shipped the naive rule.**
`identity/src-routes/identity-routes.ts` built its advisor inventory with
`expired: expiry < now`, so the identity-advisor bot was being handed nine healthy accounts marked
expired and told to tell the user to reconnect them. Fixed in the same pass (identity 1.0.1): the
inventory now calls core's `isConnectionExpired`, carries a `refreshable` flag so the bot can read
a past expiry correctly, and the prompt says outright that a refreshable lapse is not a problem.
The original observation — that the two paths disagree — was right; the conclusion that the
review was the correct one was wrong.

**Guards (both halves of a cross-repo contract).**
`tests/unit/connector-list-expiry.spec.ts` pins the producing side: the per-connection key set on
both the provider entries and the any-llm entry, the expiry semantics (refreshable / unrenewable /
no-expiry / boundary), the end-to-end derivation, and no token material in the response.
`identity/tests/identity-list-contract.test.js` pins the consuming side: every `c.<key>` the
surface reads is in the promised set, `c.expired` is still read in all four places, and the
inventory uses the shared rule rather than re-deriving `expiry < now`. Mutation-proved on both
sides — drop the projected field, revert to the naive rule, or make the surface read an unpromised
key, and the matching guard goes red.

**Not fixed, and deliberately:** a connection with no refresh token and an expiry still in the
future will lapse silently one day, and nothing warns ahead of time (five connections on this
deployment are in that state). That is a new capability, not this defect — logged in BACKLOG.

## BUG-14 — Notifications copy describes only one of the two credential tiers
- **Type:** Bug (copy accuracy) · **Priority:** Low · **Status:** OPEN
- **Discovered:** 2026-08-09 by the as-built review behind
  [the Platform tools guide](../guides/platform-tools.md); **scope corrected the same day by the
  operator** — the first write-up of this entry called the service tier "a shared deployment
  credential" and filed it High as a trust claim. That framing was wrong and is recorded here so it
  is not repeated.
- **The design is intentional and correct.** Notification channels have **two credential
  classifications**, exactly like any mail stack that has both a user mailbox and a service relay:
  1. **Personal (BYO)** — the user signs up with the provider and connects it; their own account
     carries the message.
  2. **Swarm service** — an administrator configures a deployment account because the swarm is
     acting as a *notification server* for users who never registered with that provider.
  `smsSender` (`src/app/routes/notify-routes.ts`) implements exactly that order: `twilioReady(pool,
  userSub)` wins first, and only with no personal connection does it use the deployment transport
  with the destination overridden to the user's own saved number. SEC-05 further tightened it to
  pass each transport's exact credential fields rather than cloning the environment. Nothing here is
  unscoped, and nothing is a defect.
- **The actual defect is one sentence of UI copy.** `src/pages/cockpit/tools/notify.html:74-76`
  reads *"Every send uses your own connected account (your Gmail, your Twilio, your Telegram chat),
  never a shared deployment credential."* That describes tier 1 only, so it is inaccurate for a user
  on the service tier — and on a demo/family deployment, where the service tier is the normal path,
  it is inaccurate for most users. Voice is service-tier only; Telegram sends through the
  administrator's configured bot; SMS uses whichever tier applies.
- **Fix:** reword the line to state both tiers plainly — your own account when you have connected
  one, otherwise the deployment's notification service, with the destination always your own — and
  surface the effective tier per channel in the routing table so it reads at choose-time. The
  honest per-channel wording already exists in the Platform tools guide.
- **Prevention:** on-surface sentences about *whose* credentials are used deserve the same as-built
  check as documentation, in both directions — this one over-promised isolation, and the first
  write-up of the bug over-stated the exposure. Describe the tier model; do not collapse it to
  either extreme.


## Unit-suite sweep (2026-08-13) — BUG-15 … BUG-17

All three entries below came out of a single `npx vitest run` over the whole unit corpus on
2026-08-13, run in passing during unrelated Jarvis surface-bridge work. **None of the three specs
imports anything that change touched** — every one of them was already red on committed `main`
before that session opened.

> **CORRECTION (2026-08-13, same day).** This header originally read *"nothing on an automatic path
> had said so"*, and cited `ci.yml` being `workflow_dispatch`-only plus a `schtasks` query that
> returned nothing. **That was wrong.** The scheduled task `OSHAL Local CI` exists, runs nightly at
> 23:30, ran on 2026-08-12 with `LastTaskResult 1`, and emailed the operator. Something did say so —
> every night. The `schtasks` grep produced no output at all under Git Bash and an empty result was
> misread as absence. The true finding is worse and is filed as **BUG-22**: the nightly gate has
> failed **twelve consecutive nights** with `unit` red every time, so a *new* red inside it is
> invisible. A permanently-red gate does not fail loudly; it fails uniformly, which is the same as
> silence. Note also that `unit` was already red on 2026-08-03, eight days before PR #186 landed the
> two guards these entries attribute the redness to. Read every "nothing said so" claim in the three
> entries below through this correction.

What remains true and verified: `.github/workflows/ci.yml:43-44` is `on: workflow_dispatch:` and
nothing else (line 24 forbids adding `push:`/`schedule:`/`pull_request:`, and
`scripts/check-workflow-triggers.js` enforces it — that design is deliberate and correct),
`.githooks/pre-push` runs `publish-gate.sh` plus a committed-HEAD `tsc --noEmit` and no tests, and
`scripts/ci-local.sh:225` (`gate_unit`) is what the nightly invokes. `gh pr checks 186` returns
exactly one check: `gate`, 5s.

One honest caveat on reading any full-suite number from that sweep: the tier is **not hermetic**, and
its red count moved between runs on the same box (3, 5, and 11 failing tests observed at different
moments). Some of that movement is doctrine working as intended — `apply-reaper-ledger-join.spec.ts`
and `schema-lock-privilege-tolerance.spec.ts` fail *loudly* when the live Postgres is absent, which is
what CLAUDE.md asks for instead of a skip. Some of it is docker/Windows-host dependence. And some of
it is BUG-16 below, which is nondeterministic *even with the stack up*. Do not quote a single
"N tests are red" figure from this sweep; three specific specs were run down, and those are these.

## BUG-15 — career-bot runs the oshal runtime but no Prometheus job scrapes it
- **Type:** Bug (observability config) · **Priority:** Low · **Status:** **FIXED 2026-08-13** — not by adding the missing target, but by deleting the list. See the closing note at the end of this entry.
- **Discovered:** 2026-08-13, by `tests/unit/swarm-container-health-signal.spec.ts` going red in the
  sweep above. **Scope corrected during verification** — the first write-up filed this **Med** on a
  blast-radius claim that did not survive checking, and that correction is recorded here so it is not
  repeated.

**This is a real product defect — a config one — and it is neither a stale guard nor a
test-environment artifact.** The spec reads two tracked files and calls one pure renderer: no
database, no network, no docker, no ports. It fails identically from a clean checkout of committed
`HEAD`. The one dirty entry in the working tree at the time (`docker-compose.oshal-local.yml`) is an
unrelated 10-line `TUNNEL_TRANSPORT_PROTOCOL` addition to the `cloudflared` service, which declares
its own `image:` and is excluded by the guard's selector.

**Where.** `docker-compose.oshal-local.yml:1968-1971` declares `career-bot` /
`container_name: oshal-local-career-bot` inheriting `<<: *bot-common`, so it runs the shared
`oshal-bot` image with `BOT_RUNTIME: bot-node` and serves the shared exporter's `GET /metrics`
(`src/app/bot-node-server.ts`). The `oshal-swarm-bots` job in `ops/monitoring/prometheus.yml:82`
lists **34** targets (`:86-119`) and does not include it. Replaying the spec's own
`composeRuntimeContainers()` (`tests/unit/swarm-container-health-signal.spec.ts:100`) against that
file: **36** runtime containers in compose, **35** `oshal-local-*:5000` targets (34 bots + 
`oshal-local-api` under `job: oshal-core` at `:60`), missing = exactly
`['oshal-local-career-bot']`, scraped-but-not-a-container = `[]`. It is one, not several — the loop
throws on the first miss, but nothing hides behind it. The failing assertion is at
`tests/unit/swarm-container-health-signal.spec.ts:290-298`.

**A working guard caught a fresh break, not a new guard finding old dirt.** `git blame -L 1965,1975`
puts every line of the career-bot block at `f89a33c9` (2026-08-11, PR #186, "packaged bots as
dedicated nodes"); that commit's file list does not include `ops/monitoring/prometheus.yml`, whose
only real change is `7d5a2ddf` (2026-08-01). The guard itself landed the *same day* as that
prometheus change — `git log -- tests/unit/swarm-container-health-signal.spec.ts` returns only
`7d5a2ddf` and `15eac50c`, both 2026-08-01. So it was green when it shipped and red the moment
career-bot arrived, ten days later. Causally proved, not inferred: temporarily inserting
`- oshal-local-career-bot:5000` into the target list turns the spec green (24/24) and does not break
the companion assertion at `:281` (`every scrape target is a real container`), because career-bot
*is* a real container under the same selector.

**The corrected scope — why Low and not Med.** The first write-up justified Med on the claim that
career-bot is the dedicated node for career-hunter's cron work (resume leases, board refresh).
**That is false.** `docker inspect oshal-local-career-bot` carries no `CAREER_HUNTER_CRON`;
`oshal-local-api` carries `CAREER_HUNTER_CRON=1`. The scheduler is a `setInterval` in the package's
`src-routes/career-hunter-cron.ts:292`, loaded into the API process, and its engine work is a child
process resolved under the API's cwd (`career-engine-runner.ts:35`, `:185`). Those leases live on
`oshal-local-api` — which **is** a scrape target and **is** covered by `SwarmApiUnreachable`.
career-bot's actual role is LLM dispatch (`oshal-app.yaml:132` `container: career-bot`; `:523-527`
routes `ticketType: career-application` to it), and `hasEndpoint()` resolves from the loaded endpoint
registry rather than from liveness, so a dead container makes dispatch *fail visibly* rather than
degrade silently onto an inline runtime the manifest opted out of. Its death shows up as a failed
career chat turn and as `career-application` tickets that stop advancing in a queue the operator
already watches. Real exposure, noticed at time of use — not the silent rot Med was argued from.

**And not under-claimed either.** This deployment actually runs it: `.env:14` sets
`COMPOSE_PROFILES=…,career-node`, satisfying the `profiles: ["career-node"]` gate at
`docker-compose.oshal-local.yml:1971`, the container is up, and
`wget -qO- http://oshal-local-career-bot:5000/metrics` from the api container returns
`oshal_up{runtime="bot-node",instance_name="career-hunter"} 1`. The exporter half works; only the
target list is missing it. **Profile-gating is not a reason to omit it** — the job's own header and
the `and on (container) max_over_time(up{job="oshal-swarm-bots"}[1h]) > 0` conjunct at
`ops/monitoring/alert-rules.yml:52-56` exist precisely so a declared-but-never-started target is
inert rather than a standing false alarm, and fifteen other profile-gated bots are already listed.

**Read the assertion message carefully, though: right now nothing is scraped at all.**
`oshal-local-prometheus` has been `Exited (255)` since 2026-08-02 *despite* `restart: unless-stopped`
in `docker-compose.monitoring.yml:67` (its last log line is a `SwarmContainerDown` rule evaluation
that "timed out in expression evaluation"); alertmanager and cAdvisor have been down since
2026-08-07. Only `scripts/monitoring-up.sh:24` starts the overlay, and neither `scripts/oshal-up.sh`
nor `scripts/oshal-deploy.sh` references it. So all 35 oshal runtime targets are equally unwatched
today — career-bot is simply the one that stays unwatched after somebody brings the overlay back.
That is the durable half of this defect, and the config fix is what survives the restart.

**Fix:** add `- oshal-local-career-bot:5000` to the `oshal-swarm-bots` `static_configs.targets` list
in `ops/monitoring/prometheus.yml`, after `oshal-local-jarvis-bot:5000` (`:101`) to keep the list in
compose order. Nothing else changes: the job already relabels `__address__` into the `container`
label (`:121-126`), so the alert identity ADR-119 needs comes for free. Then run
`bash scripts/monitoring-up.sh` — the config fix is inert while the overlay is dead.

**CLOSED 2026-08-13 — the class, not the instance.** Operator, on reading this entry: *"how can a
bot not be scraped? it should be engrained with the process. the RCA and Prometheus model is a
default swarm entity, self healing is in the core."* Right — and adding `oshal-local-career-bot:5000`
to the list would have fixed this instance while leaving the class wide open, because the list itself
was the defect: a second source of truth for "which bots exist", which drifts the first time someone
adds a bot.

Both runtime jobs now use `docker_sd_configs` filtered on a container label. `x-bot-common` — the
anchor every bot and the api already inherit — carries `oshal.tier: worker`, and `oshal-api`
overrides it to `core`. A new bot is scraped from its first second of life; the only way to be
unmonitored is to not be an oshal runtime container. Job names are unchanged, so no alert rule moved.
Prometheus does **not** hold the Docker socket: a read-only socket proxy exposes only
`GET /containers/json` and `GET /networks`, because a `:ro` bind restricts the file and not the API.

Verified live after a fleet-wide recreate: **35 targets discovered — 1 core, 34 workers, no
duplicates, career-bot among them — with no target list anywhere.** Two traps surfaced only by that
live run and are now closed in config and in the guard: `docker_sd` emits a target per exposed port
(every bot was discovered twice, once on a permanently-down `:1455`, which would have fired
SwarmContainerDown for the entire healthy fleet), and the port label is `__meta_docker_port_private`,
not `__meta_docker_port_private_port` — the wrong name silently drops every target instead of
erroring.

The **Fix** paragraph above is left as written and is now obsolete: it says to add the target to the
list. It is retained because it is what the evidence supported at the time, and because the gap
between "fix the instance" and "delete the class" is the useful part of this entry.

**Prevention (guard-per-fix):** the guard already exists and already worked — do not add a second
one. Close the two gaps around it. (1) Put the unit tier on a path that runs without a human choosing
to run it, or quarantine it with a same-day BACKLOG entry per doctrine; and fix `ci.yml`'s own banner
while you are there, because it is drifted in two directions — `:15` claims "plus the PR gate", but
the workflow has no `pull_request:` trigger at all, and it claims "a single NIGHTLY RUN on the
operator's machine", while `schtasks /query` shows no such task on this box. **The nightly is
documented, not scheduled.** (2) `docs/building-a-bot.md` contains **zero** occurrences of
`prometheus`, `scrape`, or `monitor` (verified case-insensitively), and its add-a-bot checklist names
registry + compose + persona YAML only — the scrape config is exactly the step PR #186 omitted, so
add it to that list. **Separately, and deserving its own entry:** nothing anywhere guards that the
monitoring overlay is *running*. A cross-file config guard is closure evidence for the config
boundary only; it cannot tell you the process reading that config has been exited for eleven days.
The observer is the one component nothing observes.

## BUG-16 — The consolidation-cutover guard runs a second alert consumer against the operator's live alert queue
- **Type:** Bug (test isolation) · **Priority:** High · **Status:** OPEN
- **Discovered:** 2026-08-13, by `tests/unit/alert-incident-cutover.spec.ts` failing in the sweep
  above. **Priority raised and framing corrected during verification** — the first write-up filed it
  Med, described only the harmless direction of the race, and asserted the product exonerated on an
  axis its own evidence argues against. All three corrections are recorded below.

**This is a test defect, not a defect in the ADR-125 consolidation path as designed — with one
caveat the entry does not get to hand-wave.** The spec resolves the operator's **live** Postgres by
default (`tests/unit/alert-incident-cutover.spec.ts:17-21`,
`postgresql://oshal:oshal@127.0.0.1:55433/oshal`), builds its own express app around
`createAlertmanagerRoutes(ticketService, { pool })` (`:112`) on an `InMemoryTicketStore` (`:109`), and
POSTs alerts into the same `oshal_alert_event` table `oshal-local-api` polls every five seconds
(`src/app/routes/alertmanager-routes.ts:878-892`, `PENDING_SWEEP_INTERVAL_MS = 5_000` at `:124`,
`FOR UPDATE SKIP LOCKED` at `src/features/alert-pipeline/services/envelope-store.ts:257`).

**The shipped behaviour was checked, not assumed.** `SKIP LOCKED` means two consumers never take the
same row, and multi-pump draining is documented intent (`envelope-store.ts:604`). The sweep is
`unref()`'d (`alertmanager-routes.ts:891`), cleared by `registerShutdownHook` (`:892`), and wrapped in
`runWithSystemIdentity` (`:887`) so `OSHAL_DB_GUC_STRICT=deny` cannot turn "retried next tick" into
"never retried". Nothing shipped is broken by two consumers sharing a landed queue.

**The race is proven, not inferred.** Incident `acc15533-1046-48df-b03a-fb87324983d2`
(`primary_target=cut-nm8-mss9115k-container`, created 2026-08-14 01:10:39Z) points at ticket
`d913d5b4-3865-48b4-bb27-39c1cb8c8df9`, which **exists in the live `tickets` table** — and the spec
cannot write a `tickets` row at all, because its ticket store is in memory. The ticket's
`status='backlog'` corroborates it: `backlog` comes from `ALERT_DEFAULT_INTAKE=backlog`, set in
`oshal-local-api`'s environment and unset in the spec's process (whose default is `approved`,
`alertmanager-routes.ts:391-394` → `alert-consolidation.ts:363`). Six such tickets exist —
`fae0561d`, `1cf752f5`, `14e4c02d`, `6850d734` (2026-08-06), `8a847de9`, `d913d5b4` (2026-08-14).
This is a repeated condition, not one bad night. The `cut-` prefix is a spec run id minted at
`:29`; event `5b3aea08` (`target=cut-nm8-mss9115k-container`) was received 01:09:02.642Z and decided
by the api at 01:12:52.577Z — 3m50s later, long after that vitest process exited.

**Correction 1 — the first write-up described the harmless direction and missed the dangerous one,
which is why this is High.** `createAlertmanagerRoutes` does not merely mount a route: it starts that
five-second sweep over the operator's **production** alert queue inside the vitest worker, and the
spec's `afterAll` (`:118-125`) closes the server and ends the pool without ever running shutdown
hooks, so the timer keeps claiming rows. That consumer is configured with
`ALERT_APPROVED_NAMES=SwarmContainerDown` only (`:92`) and a throwaway ticket store. A real
`SwarmContainerDown` claimed by it is stamped `claim_decision='created'` against a ticket that never
existed outside memory; any other real alertname falls to `unclaimedPolicy()`, which defaults to
`'drop'` (`src/features/alert-triage/services/claim-registry.ts:293`), and is stamped `noise` —
decided forever, no ticket, no operator signal. Real alerts do land here (194 `alertmanager`
envelopes since 2026-08-02, on targets like `oshal-local-api` and `oshal-local-home-bot`). The
phantom-ticket outcome has actually occurred: incident `1faf0387-…` (2026-08-06) points at ticket
`d7130a1c-…`, which is **not** in `tickets` — on that run the spec's process won.

**And do not over-claim it in the other direction.** No real production alert is known to have been
swallowed: the current decision distribution is created 3 / bundled 1 / resolved 34 / consolidated 5,
with **zero** `noise`, `dropped`, `failed` or `pending` rows. The mechanism is proven and a phantom
link is proven; the swallow is not. The window is narrow because the api drains in-request the
instant it lands a delivery (`:846`) and normally wins the row — the exposure is when that
fire-and-forget drain fails or the api is bouncing, which is exactly when container-down alerts fire.
A guard whose worst case is "silently absorb a real container-down alert during a deploy" is not a
Med.

**Correction 2 — "no product defect" is right about the design and NOT established for the link
step.** The observed red signature is `expected null to be truthy` at `:148` — an incident row whose
`ticket_id` is NULL — and the race as first written cannot produce that. A `ticket_id` stamped by the
deployment is *truthy*; that path reddens `:150` (`expect(ticket).toBeTruthy()`, the spec's
`InMemoryTicketStore` not knowing the deployment's ticket), never `:148`. Every ticketed decision
carries a required ticket id (`src/features/alert-triage/services/alert-consolidation.ts:79`) and
`alertmanager-routes.ts:706-708` stamps it. An incident with a NULL `ticket_id` has exactly two
in-code origins and **both are product code**: (a) `updateIncident` returned null on a stale revision
(`incident-store.ts:547-554`, `WHERE incident_id=$1 AND revision=$2`) and `alertmanager-routes.ts:707`
**discards that return** — no throw, no log, incident permanently unlinked; (b) a write inside
`recordIncident` threw, which *is* logged at ERROR ("Incident row write failed — the ticket stands and
the event is still decided", `:723-730`) but leaves the event stamped decided, so nothing retries the
link. Contention is the trigger for (a); the discarded return is what turns a lost race into durable,
unlogged wrongness. That question needs its own reproduction and its own guard and **must not be
closed by a test-isolation fix**.

**Correction 3 — the pollution complaint was right in kind, wrong in attribution, and understated in
aggregate.** All **26** rows in `oshal_incident` — ADR-125's state of record, "the incident is a ROW"
— are spec residue, and not one is a genuine incident. **24** are `probe-target` rows (19 open, 5
archived, 2026-08-06 → 2026-08-13) left by the *sibling* `tests/unit/alert-incident-reopen.spec.ts`
(`:63`, `:175`); this spec contributes **2**. Useful for the fix: the reopen spec drives
`IncidentStore` directly (`:153`) and never lands into `oshal_alert_event`, so it leaks residue but
does not race. `alert-incident-cutover.spec.ts` is the only DB-backed unit spec that stands a
*receiver* over the production queue.

**Two supporting complaints from the first write-up do not hold.** The DSN-bound unit-spec count is
**7**, not 5 — `alert-incident-cutover`, `alert-incident-reopen`, `apply-reaper-ledger-join`,
`bot-db-least-privilege`, `ci-local-gate-reliability`, `schema-lock-privilege-tolerance`,
`topology-traversal` (verified against the tree; the original grep was too narrow). And "red on a box
without the stack" *inverts* the doctrine it invoked: fail-loud-not-skip is mandated by CLAUDE.md and
stated in-line in those specs — that redness is the guard working. Only the nondeterminism on a box
**with** the stack is the defect. The `docs/governance/real-boundary-regression-audit.md` complaint is
also mostly wrong: that document indexes *boundaries* and their mock dispositions, not every spec that
touches a real database, and this spec's one double (the ticket store) is already dispositioned there
with `tests/alert-intake-rls-live.spec.ts` as its real companion.

**One deterministic second defect, independent of the race.** With no DB reachable the `beforeAll`
diagnostic fires correctly (`:97`, "requires the live oshal Postgres … bring the stack up with
`bash scripts/oshal-up.sh`"), but `afterAll` then hangs: `:119`
(`await new Promise<void>((resolve) => server?.close(() => resolve()))`) never settles when `server`
is undefined, so vitest stacks `Hook timed out in 60000ms` on top and the run takes ~64s. Reproduced.
A loud failure buried under a bogus one is not loud.

**Evidence provenance, stated plainly:** on this box the spec ran **green** (2 passed, ~3s) and the
`afterAll` hang reproduced deterministically (64.03s). The red is attested by the sweep's transcript
and by durable artifacts — the six live tickets and the 3m50s-late event decision above — not by a
failing run reproduced on demand.

**Fix:** the guard must own its database, not borrow the operator's. Create a scratch database or
schema in `beforeAll` with migrations 104-108 applied, run against it, and drop it in `afterAll` — no
live consumer can then see its rows, and its receiver's sweep can never see a live one. If the live
instance must stay the substrate, the receiver has to be constructed **without** a sweep (a
`sweep: false` option on the route options, or an exported `drainPendingEvents` the spec calls
directly), and `afterAll` must run shutdown hooks before `pool.end()`. Fix the `:119` hang in the same
pass. Delete the two stray incident rows and the stray event — cleanup, not the fix — and do
`alert-incident-reopen.spec.ts` in the same pass, since its 24 rows are the bulk of the contamination.
**Not folded into this fix, and each needs its own look:** the discarded `updateIncident` return at
`alertmanager-routes.ts:707`; and the pool-vs-executor contract, where `incident-store.ts:472-473`,
`:552`, `:572` and `dispatch-log.ts:165` all write on `this.pool` inside the `withPendingEvents`
transaction against the invariant at `envelope-store.ts:609-610`. Note that the invariant's own
comment is wrong about *why* — the claim transaction locks `oshal_alert_event` only and the handler's
writes touch `oshal_incident` / `_member` / `oshal_alert_dispatch`, so there is no lock overlap and no
deadlock. The real consequence is loss of atomicity: those rows commit even when the claim rolls back
and the event returns to `pending` for the sweep to re-consolidate.

**Prevention (guard-per-fix):** a unit assertion that no spec under `tests/unit/**` constructs
`createAlertmanagerRoutes` with a pool it did not create for itself, plus a cheap `ci-local.sh`
post-gate that fails when `oshal_incident` holds a row whose `primary_target` matches the specs'
synthetic prefixes — residue in the operations stream should go red on the next run, not accumulate
for a week. The rule these two specs broke: **a DB-backed guard may read the operator's schema, but it
must never start a background consumer on the operator's work queue.**

## BUG-17 — The task/message credential-isolation guard asserts a retired route shape, and half of what it does assert is bound to a symbol that no longer exists
- **Type:** Bug (stale guard) · **Priority:** Med · **Status:** OPEN
- **Discovered:** 2026-08-13, by `tests/unit/task-message-isolation-routes.spec.ts` failing in the
  sweep above. **Both halves of the first write-up were corrected during verification** — its blast
  radius was over-stated and its guard-coverage loss was under-stated; the Med below is re-based on
  the second of those, not the first.

**Stated plainly: this is a stale guard, not a credential-isolation regression.** Isolation on this
route is intact, and that was verified at the boundary rather than by inspection — with stub HTTP
nodes bound on 3034/3032 and `warmBotEndpointRegistry()` awaited, both turns returned 200 and
**neither posted body carried a `creds` key**. Structurally: `src/app/routes/message-routes.ts`
contains zero occurrences of `creds` or `providerIntent`; the request literal at `:263-271` is exactly
`{text, taskId, workspaceFolderId, agentId, agenticMode, direct, userSub}`; and
`src/app/routes/inline-bot-execution.ts:393-405` still throws `UNSCOPED_CREDENTIAL_CARRIER` (creds
without a validated `providerIntent`) and `PROVIDER_INTENT_REQUIRES_BOT_NODE` (creds/intent on an
endpoint-less bot) — that second guard **is** "no connector credential on the controller-inline
localhost path", and it has its own live, falsifiable guard at
`tests/unit/inline-bot-execution.spec.ts:104-118`. The node-failure path is fail-closed:
`message-routes.ts:403-441` maps a dispatch failure to 500 (or 202 when a ticket was already created)
with no inline re-run.

**Why it is red.** `tests/unit/task-message-isolation-routes.spec.ts:153-217` drives
`POST /api/send-message` with two agent ids and asserts the turn lands on
`ctx.orchestrator.processMessage` (`:215`). PR #186 (`f89a33c9`, 2026-08-11, one-chokepoint chat
routing) inserted a node-dispatch branch at `message-routes.ts:240`
(`if (botClient.hasEndpoint(resolvedAgentId))`) → `executeBotOrInline` at `:263` → HTTP to the bot's
own node. Both ids are node-backed: `b0000000-…-0001` = communications-bot, container `email-bot`,
port 3034 (`src/app/extensions/swarm/swarm-bot-registry-local.ts:205-215`); `a0000000-…-0036` =
weather-bot, container `weather-bot`, port 3032 (`:226-238`). Neither container is in
`CONTROLLER_INLINE_CONTAINERS` (`src/features/agent-management/services/bot-node-client.ts:59`).
Pre-#186 the route had no such branch at all — `git show f89a33c9^:src/app/routes/message-routes.ts |
grep -c "botClient\.\|executeBotOrInline("` returns **0**, which is precisely the shape the spec still
encodes. #186 updated three specs (`inline-hosted-brain-entry-points`, `manifest-bot-runtime`,
`remote-brain-stamp`) and left this one pointing at the retired one; its own last touch was
`76d5788e` (2026-08-06), five days before the routing change.

**The proximate trigger is environmental, but an environment fix alone cannot close it.** Nothing
listens on 127.0.0.1:3032 in the unit runner, so the (correct) dispatch takes `ECONNREFUSED`, the
catch returns 500, and `expect(weatherResponse.status).toBe(200)` fails at `:213`. Deterministic
across repeated runs. Both halves are required: fixing only the environment leaves `:215` red forever,
because the node path never calls `ctx.orchestrator.processMessage`; and a spec-only rewrite stays red
too, because nothing listens on 3032. The spec also cannot steer the branch by shaping `ctx` —
`botClient` is a module-level singleton constructed at `message-routes.ts:45`, not injected.

**The correction that matters most, and it cuts against the guard rather than the product: two of the
spec's four credential assertions cannot fail.** `:198` and `:214` are
`expect(brokerMocks.resolveBotCreds).not.toHaveBeenCalled()`, and
`src/app/routes/connector-token-broker.ts` exports exactly one function —
`resolveServerOperationCreds` (`:107`) — plus the type `ServerCredentialUse` (`:105`). `76d5788e`
(PR #142, 2026-08-06) renamed `resolveBotCreds` → `resolveServerOperationCreds` in the **same commit**
that flipped this assertion to `.not.toHaveBeenCalled()`. No module imports a binding by the old name;
the `vi.mock` at `:8` replaces the module with a symbol the real module has not had for a week, so
re-introducing brokering through the current name would sail straight past it. This is the
substring-guard-is-not-a-guard shape: a security-named assertion that **cannot go red**. Fixing the
500 restores one live assertion per leg, not two. (Correspondingly, the first write-up's claim that
`resolveBotCreds` has four importers is wrong — two of the four cited sites are change-log comments,
and the two real imports, `src/app/extensions/swarm/index.ts:179` and
`src/app/routes/travel-farewatch.ts:49`, import the *new* name.)

**And the leg that currently passes passes by a race, not by design.** Both agent ids are node-backed,
so the email leg's `:198-199` only execute because the **first** `hasEndpoint()` probe hits the
cold-registry fallback — `loadActiveBotEndpointRegistry` cannot resolve the `.ts` registry through the
synchronous CJS `require` under vitest (WARN "Bot endpoint registry not synchronously loadable",
`bot-node-client.ts:733-756`, change-log seq 20), returns `[]`, and kicks a warm. The measured gap
between the two POSTs was ~37ms against a ~35ms warm: the outcome landed the same way five runs
running, but it is a coin flip, not a margin. (The first write-up read that gap as ~9.5s and called it
"ample"; it does not reproduce.) With stub nodes bound and the warm awaited, `processMessage` is never
called for **either** id — so the route currently has no inline-shape coverage for these two bots at
all.

**Not a production defect, with the evidence rather than the assertion.** `package.json` declares no
`"type": "module"`, `tsconfig.json` and `tsconfig.server.json` both set `module`/`moduleResolution`
`Node16`, and `scripts/bot-entrypoint.sh:218` runs `node dist/app/server.js` — so the extensionless
CJS require resolves in the deployed artifact and the inline fallback never fires there. One honest
residual, deliberately not filed as a defect: the hot-swap override runs `tsx watch src/app/server.ts`
(`docker-compose.hotswap.yml:60`), where that same require is resolved by tsx's hook rather than plain
Node. If it ever failed there, a node-backed bot's first turn would run controller-inline — which is
literally the "localhost model fallback" this spec is named after. Not credential exposure either way
(the inline path refuses creds and provider intents), but a routing degradation worth knowing about.

**Blast radius, corrected downward.** The first write-up said the local unit gate "has been red on
this single case since 2026-08-11". It has not: a full `npx vitest run` at HEAD returned 11 failed /
676 passed across 687 files in one observation, and fixing this case does not turn `gate_unit` green.
Some of those reds are the fail-loud-when-the-env-is-missing shape doctrine asks for; one is BUG-15
above; several are docker/Windows-host dependent. Related and worth its own look:
`tests/unit/inline-hosted-brain-entry-points.spec.ts` — the file that carries #186's *real*
node-dispatch guard — is itself flaky on the same registry-warm race (failed in some batch runs,
passed alone and in the full suite). The first write-up cited it as a clean sibling; it is not, which
means #186 left **two** specs behind, not one.

**Fix:** do not repair the case in place. #186 already shipped the right shape at
`tests/unit/inline-hosted-brain-entry-points.spec.ts:427-495` — it boots a real local HTTP bot node on
an ephemeral port, awaits `warmBotEndpointRegistry()` before driving the route (`:454-457`), and
asserts the exact `/api/swarm-execute` body. Add `expect(node.bodies[0]).not.toHaveProperty('creds')`
(and the same for `providerIntent`) there, which restores the node-half credential property at the
boundary that actually crosses, and stabilise that file's warm race in the same pass. Then either
retarget the stale case in `task-message-isolation-routes.spec.ts` to a genuinely controller-inline
agent — one whose container **is** in `CONTROLLER_INLINE_CONTAINERS` — so it guards the inline branch
it was written for, or delete it; leaving it aimed at two node-backed bots guards nothing. Either way,
re-point the two vacuous assertions at `resolveServerOperationCreds`, and assert the credential
property **before and independently of** the transport status. Nothing in `src/` should change.

**Prevention:** three, in the order they actually failed here. (1) A route that gains a new execution
branch must re-point every guard that names it **in the same change** — a
`grep -rl "app/routes/message-routes" tests/` at review time would have caught both stragglers.
(2) A security guard must not lead with a liveness assertion: putting `expect(status).toBe(200)` ahead
of the credential checks is exactly what let a transport change silently convert a security guard into
a dead one. (3) A mocked symbol must be proved to exist — mutation-test the assertion (make the route
call the real broker, confirm the guard goes red) rather than trusting the name, because this one has
been dead since 2026-08-06 and nothing noticed. And under the real-boundary doctrine: a guard about
*what crosses the controller→node boundary* has to observe that boundary — the posted body — not a
controller-side collaborator the boundary no longer uses.

## BUG-18 — The assistant invents a `custom` op name, and the surface silently discards the edit
- **Type:** Bug (integration contract / silent no-op) · **Priority:** High · **Status:** FIXED
  2026-08-13 (oshal#206, oshal-applications#78)
- **Discovered:** 2026-08-13 by a **live end-to-end test** of the new screen-aware Jarvis path,
  run through the headless localhost credential (`x-service-secret` + `x-oshal-user-sub`) at the
  operator's direction. Every unit guard for the feature was green — 31 of them — and the feature
  still did not work. This entry exists mostly to record *why the tests could not have caught it*.
- **What happened.** With Resume Studio's context attached, Jarvis was asked to tighten a resume
  summary. It replied:

  ```
  Done — I made it shorter and centered the platform work.
  ```oshal:surface
  {"ops":[{"op":"custom","name":"update_master_resume_summary","data":{…}}]}
  ```

  Every layer behaved correctly. The fence parsed. `extractSurfaceDirectives` validated the op
  against the closed outbound vocabulary and accepted it — `custom` *is* a legal op. The cockpit
  relay checked the trusted `?app=` binding and the manifest allow-list and passed it. The surface
  **received** it. `career-resume-studio.html` matches on `detail.name !== 'resume_action'`, so it
  returned immediately and the edit was discarded. The user was told the edit had happened.
- **The defect is the contract, not any one layer.** `can: ['custom']` tells the model that
  `custom{name,data}` is available but not *which name* the surface answers to, so it invents a
  plausible one. Generalized: **advertising a capability whose vocabulary the model has to guess
  does not produce an error, it produces a confident lie.** Every validation boundary in the chain
  is a *shape* check; none of them could know that `update_master_resume_summary` is not a name this
  app listens for, because until this fix nothing in the system recorded that fact.
- **Why the guards were green and stayed green.** The unit specs asserted the transport (the op
  relays, the app binding is stamped, the allow-list holds) and the surface handler (a
  `resume_action` applies through `applyAction`). Both halves were correct in isolation. Nothing
  compared *what the model emits* against *what the consumer matches on* — the two ends of the
  integration were tested against each other's fixtures, never against each other.
- **Fix.** `ContextSchema.customOps: [{name, description}]`
  (`src/features/surface-bridge/types.ts`) — a surface publishes the exact `custom` names it handles
  and the payload each expects; the description reaches the prompt verbatim, so it also carries the
  app's action vocabulary. `buildSurfaceContextPrompt`
  (`src/app/routes/jarvis-surface-context.ts`) prints them and requires the name be used VERBATIM,
  stating that an invented name is discarded. And `custom` is now **dropped from the advertised op
  set** when a surface declared no names for it — withholding a capability beats inviting a silent
  no-op. Resume Studio declares `resume_action` plus its full action vocabulary
  (`career-hunter/tools/career-resume-studio.html`).
- **Verified live after the fix**, same message, same context: `{"op":"custom","name":"resume_action",
  "data":{"actions":[{"op":"set_summary",…}]}}` — correct name, real vocabulary, correct wrapper
  shape; raw reply 389 chars, persisted answer 65, so the fence was extracted and stripped.
- **Prevention.** Three rules, in order of how much they would have saved:
  1. **A guard must compare the two ends of an integration, not each end to a fixture.** The store
     guard now asserts the declared name EQUALS the name the handler matches on; it is
     mutation-tested by renaming the declaration to `update_master_resume_summary`, the exact wrong
     value observed live.
  2. **Never advertise a free-text identifier to a model without enumerating the legal values.**
     If the set cannot be enumerated, do not offer the capability.
  3. **A green suite is not a working feature.** This was found in the first live run and could not
     have been found otherwise; the honest posture is that a feature is unproven until it has been
     exercised end to end. See also the observability gap below.
- **Related gap, not yet fixed.** There is a log line when surface ops are *dropped* for lack of
  context, but none when they are successfully emitted. Proving this bug required reading the raw
  pre-strip reply out of the bot container log, because the clean answer and the persisted turn
  both have the fence already removed. A success-path log line would have made the mismatch
  visible in one grep.

## BUG-19 — A stale-revision incident patch is discarded, leaving the incident permanently unlinked with no error and no log
- **Type:** Bug (silent data loss) · **Priority:** High · **Status:** OPEN
- **Discovered:** 2026-08-13, split out of BUG-16's verification, which explicitly refused to close
  it with a test-isolation fix. Independently re-verified against the tree before filing.

**This is product code, not test fallout.** `IncidentStore.updateIncident`
(`src/features/alert-pipeline/services/incident-store.ts:536`) is an optimistic-concurrency write —
`WHERE incident_id = $1 AND revision = $2 ... RETURNING *` (`:549-551`) — returning
`IncidentRow | null`, where `null` means *the revision moved under me and nothing was updated*
(`:554`). That is deliberately not an error: `null` is the caller's signal to re-read and retry.

**The one caller that matters throws that signal away.** `src/app/routes/alertmanager-routes.ts:707`
awaits `incidents.updateIncident(incident.incidentId, incident.revision, { ticketId: decided.ticketId })`
with the result unassigned, unchecked, and unlogged. When the revision has moved — exactly what
contention produces — the ticket link is silently never written. The incident row stays in
`oshal_incident` with a NULL `ticket_id` **forever**: nothing retries it, because the event was
already stamped decided, and nothing reports it, because `updateIncident` logs the miss only at DEBUG
(`:553`, `applied: result.rowCount`) and the route logs nothing at all.

**Why this, and not the race, is the likely cause of the observed symptom.** BUG-16's red signature is
`expected null to be truthy` at `alert-incident-cutover.spec.ts:148` — an incident whose `ticket_id`
is NULL. A `ticket_id` stamped by a competing consumer is *truthy*, so that path reddens the
following assertion, not this one. A NULL `ticket_id` has exactly two in-code origins and both are
here: this discarded return, and a throw inside `recordIncident` (which at least logs at ERROR,
`alertmanager-routes.ts:723-730`, but still leaves the event decided so nothing retries the link).
ADR-125's whole premise is that the incident is a row pointing at its ticket; an unlinked incident is
that premise quietly failing.

**Fix:** capture the return. On `null`, re-read the incident and retry the patch against the fresh
revision (bounded); if it still fails, log at ERROR with `incidentId`/`revision` — the same honesty
`recordIncident`'s own failure path already shows. Do not silently proceed. Audit the other
`updateIncident` callers for the identical shape in the same pass.

**Prevention (guard-per-fix):** a spec that drives a genuine revision conflict — patch once to bump
the revision, then call with the stale revision — and asserts the link is either applied or loudly
reported, never dropped. Per the integration-boundary corollary this needs a real store against the
enforcing role, not a mocked one: the defect *is* the database's optimistic-concurrency behaviour.
More generally: **a function returning `T | null` to signal "your write did not happen" must never be
called with `await` alone.** Worth a lint rule if a second instance turns up.

## BUG-20 — Incident writes run on the pool inside the claiming transaction, so they survive a rollback that reverts the claim
- **Type:** Bug (lost atomicity) · **Priority:** Medium · **Status:** OPEN
- **Discovered:** 2026-08-13, split out of BUG-16's verification. **The verifier corrected the
  documented rationale as well as the code**, and both halves are recorded here.

**The invariant is explicit.** `EnvelopeStore.withPendingEvents`
(`src/features/alert-pipeline/services/envelope-store.ts:616`) claims events `FOR UPDATE SKIP LOCKED`
and runs the handler *inside* that transaction, so a crash reverts the rows to pending rather than
stranding them claimed. Its contract says so at `:609-610`: *"The handler receives the transaction
client and MUST use it for its own writes."*

**The handler does not honour it.** `IncidentStore` issues its writes on `this.pool` — `:472-473`
(`findLatestInstance` / `upsertLive`), `:552` (the `updateIncident` patch), `:572` and `:601`
(member upsert / resolve) — and `dispatch-log.ts:165` does the same. Those run on a *different
connection*, outside the claiming transaction.

**The stated reason for the rule is wrong, and the real consequence is worse than the stated one.**
The comment predicts a deadlock ("a write issued on the pool would wait on locks this transaction
holds"). It does not deadlock: the claim transaction locks rows in `oshal_alert_event` only, while
these writes touch `oshal_incident`, `oshal_incident_member`, and `oshal_alert_dispatch` — no lock
overlap, which is why this has never hung and why nobody noticed. The actual consequence is **loss of
atomicity**: if the handler throws after these writes, or the claim transaction rolls back for any
reason, the incident/member/dispatch rows are already committed while the event returns to `pending`
and is re-consolidated on the next sweep. Duplicate or orphaned incident state, produced by a
mechanism designed to make exactly that impossible.

**Fix:** thread the transaction client through the handler to `IncidentStore` and `dispatch-log` (an
executor parameter defaulting to the pool for the non-transactional callers) so every write in a
claim lands on the claiming connection. **Correct the invariant's comment in the same change** — it
should say "so the handler's writes commit and roll back with the claim", not "or it will deadlock".
A rule justified by a consequence that cannot occur is a rule people learn to disregard.

**Prevention (guard-per-fix):** a spec that makes the handler throw after an incident write and
asserts no `oshal_incident` row survives once the event is back to `pending`. Real database, real
transaction — mocking the executor here would mock precisely the boundary the defect lives on.

## BUG-21 — The monitoring overlay is not running, nothing starts it, and nothing notices it is gone
- **Type:** Bug (observability / operational) · **Priority:** High · **Status:** **FIXED 2026-08-14** (#213) — see the closing note at the end.
- **Discovered:** 2026-08-13 while triaging BUG-15, which recommended filing this separately because
  a cross-file config guard cannot see a dead process. Verified directly against the box.

**The observer is the one component nothing observes.** `docker ps -a`: `oshal-local-prometheus` —
**Exited (255) 11 days ago** (2026-08-02), *despite* `restart: unless-stopped` in
`docker-compose.monitoring.yml`; its last log line is a `SwarmContainerDown` rule evaluation that
"timed out in expression evaluation". `oshal-local-alertmanager` — **Exited (0) 7 days ago**.
cAdvisor likewise.

**Nothing brings it back.** `grep -c monitoring scripts/oshal-up.sh scripts/oshal-deploy.sh` returns
**0 and 0**. The overlay starts only from `scripts/monitoring-up.sh`
(`COMPOSE_FILE=docker-compose.monitoring.yml`), by hand. So the documented recovery path after an
engine restart — `bash scripts/oshal-up.sh` — brings the swarm up monitored in name only, and
`oshal-deploy.sh` does the same on every deploy.

**What is inert while it is down:** every rule in `ops/monitoring/alert-rules.yml`; the
`SwarmContainerDown` signal; the ADR-119 self-healing ladder that hangs off it; and the alert-intake
half of the ADR-125 operations stream, since no alert is generated to intake. `up` never goes 0
because nothing is being scraped. A container can die and nothing anywhere notices — the 2026-08-01
drill this tooling was built for is currently un-runnable.

**A green deploy is not evidence of monitoring.** `scripts/oshal-deploy.sh` prints
`census: N healthy / N app containers` and `0 unhealthy` from Docker's own healthchecks. That line
printed truthfully three times on 2026-08-13 while nothing had been scraped for eleven days. Docker
healthchecks and the monitoring overlay are independent; do not read one as the other.

**Fix:** two parts, and the second is the one that lasts. (1) `bash scripts/monitoring-up.sh` to
restore the overlay, and root-cause the exit 255 — `restart: unless-stopped` did not bring it back,
meaning it exited in a way Docker treated as final, which itself wants explaining. (2) Bring the
overlay up as part of `scripts/oshal-up.sh` (already the ordered bring-up path and already tier-aware),
or state explicitly in that script and the deploy runbook that monitoring is a separate operator
action. The current silence is what let eleven days pass.

**CLOSED 2026-08-14 (#213).** All three halves:
1. **Running** — the overlay is up; the exit 255 did not recur across several restarts, so it is
   recorded as unexplained rather than diagnosed.
2. **Started with the swarm** — `scripts/oshal-up.sh` brings the overlay up after the fleet,
   advisory so a deployment with no `ALERT_WEBHOOK_TOKEN` gets a loud banner instead of a failed
   bring-up.
3. **Watched** — `scripts/monitoring-liveness-check.sh` asserts Prometheus is reachable, has
   DISCOVERED targets, and that each is up, naming any that are not. Advisory by default,
   `--strict` for ci-local. Both failure paths tested.

⚠ **Fixing this surfaced a worse defect that nothing else would have caught.** The move to service
discovery (BUG-15) silently disabled `SwarmContainerDown`: with a static list a dead container still
had a target and reported `up == 0`, but a discovered container that dies **disappears**, so
`up{...} == 0` matches no series. Confirmed by stopping a real bot — the alert sat `inactive`, which
means self-healing was dead fleet-wide. Both liveness rules are now
`max_over_time(...) > 0 unless on (container) (... == 1)`, aggregated on `container` because
`instance` is IP:port and churns on every recreate (the first correct-looking form alerted for 26
healthy bots). Proven end to end: stopped → firing for exactly that bot → restarted → inactive.

The lesson worth keeping: a bring-up that prints `0 unhealthy` proved nothing here, and a config
guard proved nothing about the process reading the config. **The only thing that found either defect
was killing something and watching what happened.**

**Prevention (guard-per-fix):** a liveness check, not a config check. `deploy-parity-check.sh` (or
`oshal-up.sh`'s census) should assert Prometheus is up and has scraped within the last N minutes —
one request against `/-/healthy` plus an `up` query — and warn loudly otherwise.
`swarm-container-health-signal.spec.ts` is closure evidence for the scrape **config** boundary and
cannot be closure evidence for the scraper **running**; per the integration-boundary rule those are
different boundaries needing different guards.

## BUG-22 — The nightly gate has failed twelve consecutive nights, emailed every time, and nothing changed
- **Type:** Bug (process / ignored signal) · **Priority:** High · **Status:** OPEN
- **Discovered:** 2026-08-13, while establishing why BUG-15 and BUG-17 reached `main` unannounced.
  **This entry is the corrected version of a claim that was wrong twice over, and the correction is
  the finding** — recorded here in full so it is not repeated.

**What was claimed, and why it was false.** The first triage of BUG-15/16/17 concluded that "nothing
on an automatic path said these were red": `ci.yml` is `workflow_dispatch`-only, `.githooks/pre-push`
runs no tests, and `schtasks /query | grep -i nightly` returned nothing, so the banner's "single
nightly run on the operator's machine" was written up as *documented but not scheduled*. **Both the
subagent that reported it and the verification of that report were wrong.** The `schtasks` query
produced no output at all under Git Bash — an empty result was read as "no such task" rather than
"the command returned nothing". `Get-ScheduledTask` shows the truth:

- Task **`OSHAL Local CI`**, State `Ready`, `MSFT_TaskDailyTrigger @ 23:30`, action
  `wscript.exe //B //Nologo C:\Projects\oshal\scripts\ci-local-hidden.vbs`.
- Last run **2026-08-12 23:30:01**, **LastTaskResult `1`**, next run scheduled.

So the gate exists, is scheduled, runs unattended, propagates a real exit code (that is exactly what
`ci-local-hidden.vbs` change-log entry 3 was for), **and notifies**: the run log ends with a
`SEND_OK` line carrying a message id and the operator's own address (`TG_SKIP not-configured`, since
Telegram has no token). Every mechanism this repo built for unattended CI worked correctly.

**The actual defect is what happened next: nothing.**
`%LOCALAPPDATA%\oshal\ci-local.log` holds 53 recorded outcomes. The last twelve:

```
2026-08-02  FAILED gates: head-src node-gates-skipped secret-scan image-build …
2026-08-03  FAILED gates: unit e2e-green trivy
2026-08-04  FAILED gates: unit secret-scan unpushed-commits e2e-green trivy
2026-08-04  FAILED gates: unit e2e-green trivy
2026-08-06  FAILED gates: unit worktree-strays unpushed-commits e2e-green trivy
2026-08-06  FAILED gates: unit worktree-strays secret-scan e2e-green
2026-08-07  FAILED gates: unit secret-scan e2e-green image-build …
2026-08-08  FAILED gates: unit e2e-green trivy
2026-08-09  FAILED gates: unit e2e-green trivy
2026-08-10  FAILED gates: unit e2e-green trivy
2026-08-11  FAILED gates: unit e2e-green trivy
2026-08-13  FAILED gates: unit e2e-green trivy
```

**Twelve consecutive failed nights. Not one green run in the window. `unit`, `e2e-green` and `trivy`
red every time**, and an email sent on each. This is the exact condition CLAUDE.md names — *"a red
gate nobody acts on trains everyone to ignore red — fix it or explicitly quarantine it with a BACKLOG
entry the same day"* — and it has been running for eleven days.

**It also corrects the BUG-15/16/17 framing.** Those entries say the three specs reached `main`
without anything saying so. Something did say so, nightly, by email. And the `unit` gate was already
red on **2026-08-03**, eight days before PR #186 landed the two guards those entries blame — so the
gate was not even reporting *those* failures when the streak began. The honest statement is not
"there is no automatic gate"; it is **"the automatic gate has been red so long that a new red inside
it is invisible."** A permanently-red gate does not fail loudly; it fails uniformly, which is the
same as silence.

**One smaller thing, verified and true.** `ci.yml` change-log entry 8 (`:15`) says CI runs on
workflow_dispatch *"plus the PR gate (which effectively never fires on this trunk-based repo)"*.
There is no PR gate — `on:` is `workflow_dispatch:` and nothing else (`:43-44`), and the banner three
lines above forbids adding `pull_request:`. "Effectively never fires" describes a trigger that exists
but is rarely hit; this one does not exist. The banner's *nightly* claim, by contrast, is accurate
and should not be touched. **The manual-only hosted-CI design is intentional and correct, and nothing
here argues for a `push:` trigger** — `scripts/check-workflow-triggers.js` exists to prevent exactly
that and should keep doing so.

**Fix:** drive the three standing gates to green or explicitly quarantine each with a dated BACKLOG
entry naming what is deferred and why — `unit` (BUG-15/16/17 and the DB-backed specs; note BUG-16
before running the suite against a live stack), `e2e-green`, `trivy` (a CVE budget decision, not a
code fix). Then delete "plus the PR gate" from entry 8. Until the streak is broken, treat any claim
that the nightly "covers" a change as false.

**Prevention:** a red gate must escalate when it *stays* red, because a daily email that always says
the same thing is wallpaper. Make the notifier state the streak ("FAILED — 12th consecutive night,
first failure 2026-08-02") and say which gates are *newly* red versus already-known — a new failure
inside a standing failure is the signal that is currently lost. And when a scheduled-task or
service-liveness claim is being checked, **verify with a tool that distinguishes "absent" from "no
output"**: `Get-ScheduledTask`, not a grep over a command that may print nothing. An empty result is
not evidence of absence — that mistake is what produced the first version of this entry.

## BUG-23 — Career Hunter AI scoring was dead for 25 days behind two credential walls, and the board looked merely "quiet"
- **Type:** Bug (silent degradation / credential posture) · **Priority:** High · **Status:** FIXED 2026-09-05 (store 1.12.4 + 1.12.5, core PR #302)
- **Discovered:** 2026-09-04, from the operator's question "are the jobs still scraping every night". The scrape was fine; scoring had not run since 2026-08-10.

**What the operator saw.** No new matches on the job board for weeks. The first thing a naive check
finds — Postgres `career_postings` frozen at 2026-07-31 — is a dormant replay target and proves
nothing; the SQLite corpus was ingesting 13–24k postings every night. The real signal was one row:
the operator's `user_signals.max(ai_scored_at)` = 2026-08-10, while every boot catch-up logged
`career-hunter cron: keyword score failed; cursor not advanced` and the title pass traceback
`RuntimeError: No AI auth found. Log into Claude Code, or set ANTHROPIC_API_KEY.`

**Root cause — two walls, not one.** Store commit `20168c9` (2026-08-06, an authz fix) sandboxed
the engine child away from the box's mounted `~/.codex` / `~/.claude` logins by pointing
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` at an empty per-user directory, with no carve for the
deployment's own logins, and the brokered per-user key (`OSHAL_CRED_ANTHROPIC`) was never presented
under the name the engine reads (`ANTHROPIC_API_KEY`) — so the tenant path was a dead end too. The
sandbox is enforced in **two** places: the runner (`career-engine-runner.ts`) and the launcher
(`bin/oshal-jobhunter.js`), which rebuilds the Python child's environment itself.

**Why the first fix did not fix it.** 1.12.4 opened the carve in the runner under ADR-127's two
gates (`DEMO_MODE` + exact operator subject) and mapped the brokered key. A runner-level proof on
the box was green — the runner's env for the operator showed no sandbox. The next live pass at
04:02Z still raised `No AI auth found`, because the launcher re-applied its own wall two spawns
down. A green proof at the wrong boundary is not closure evidence; the boundary that raised the
error is the one to prove.

**Fix.** 1.12.5: the runner states its verdict as `OSHAL_PORTAL_LOGINS=1` (set only under both
gates; any caller-supplied copy is stripped) and the launcher lifts its wall only on that exact
value, passing `HOME` through. Core PR #302 recorded the credential posture as ADR-137 amendment A
(demo = portal fallback, tenant = per-user keys) and added the satellite "Log in + push" so a swarm
whose browser is elsewhere can still be logged in.

**Proof.** After the 1.12.5 restart the catch-up pass ran `python3 -m jobhunter score --min-keyword
40 --first-seen-days 3 --limit 250` with four `codex exec` workers, and the operator's board gained
53 AI-scored postings (fit 10–84) within six minutes — the first since 2026-08-10.

**Guards.** Store: `career-no-sync-api.test.mjs` (wall vs carve at the runner, brokered-key
mapping, verdict stripped for a guest), `career-portal-logins-launcher.test.mjs` (loads the real
launcher: walled without the verdict, lifted only on `'1'`, near-misses stay walled). Core:
`claude-code-demo-login-adoption.spec.ts`, `claude-code-credential-distribution-boundary.spec.ts`,
`node-login-push.spec.ts`.

**Lessons recorded.** (1) "Scrape fresh, scores stale" is the outage's signature — it is now the
first row of the failure table in `career-hunter/docs/operations.md`, with the admin checks that
would have caught it in a minute (`last_cron_score_at` only advances on a *successful* pass).
(2) Prove at the boundary that raised the error. (3) The api restarts several times a day on this
box; a scoring pass killed mid-run keeps its rows but not its cursor, so it re-runs at the next
boot — progress accumulates, the cursor moves only on completion.

**Still open (BACKLOG):** codex platform promotion on this box is blocked by an empty
`ENCRYPTION_KEY`; the satellites run the pre-push node build; the user-targets browser round-trip
(1.13.0) has not been exercised from a real session.
