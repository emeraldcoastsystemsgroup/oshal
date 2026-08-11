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
- **Type:** Bug · **Priority:** Med · **Status:** OPEN
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
  how it got to twenty. Tracked in [BACKLOG.md](../BACKLOG.md) → "Shared product experience".

## BUG-13 — Identity Hub's expired-login signal is dead UI (the field is never sent)
- **Type:** Bug · **Priority:** Med · **Status:** OPEN
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
  either repo, and the Access Review path is unaffected — it computes expiry itself from the stored
  `expiry` value rather than trusting the list response, which is why the same page can report a
  stale account in the review while showing zero in the tile.
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
