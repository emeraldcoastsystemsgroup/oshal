# Knowledge-owner routing — config checklist

Execution checklist for **[ADR-083](../adr/083-knowledge-owner-call-out-routing.md)** (kill the semantic
regex; route Jarvis tasks via the queue manager's call-out to knowledge owners). Derived from a 16-bot
audit run 2026-07-09. Most items are **configuration** (heartbeat seeding, DB tool grants, persona/registry
declaration fields); the routing wiring and the regex deletion are the only code.

> **STATUS 2026-07-09 (evening): EXECUTED + LIVE-VERIFIED.** All 12 owners promoted to any-bot nodes
> and heartbeating; declarations + collision fixes shipped across registries/personas/manifests/compose
> + DB; the regex is deleted and the call-out routes the task lane. Two live probes (the previously
> misrouted trading-audit ask) routed to **trading-analyst** (`routedBy: llm` in ticket metadata),
> probe 2 executed **on the trading-bot node** (`requiresOwnNode`), cost landed under agent …046,
> and the live autopilot ran cleanly post-deploy. **Tier-1 is LIVE (same evening):** the initial
> `responded: 0` gap (bot-node-server built its SwarmAgentWorker with no directHandler — nodes
> received BID_REQUESTs over Redis and dropped them) is closed by the shared
> `mesh-bid-responder.ts`, whose self-score reads the bot's OWN persona routing keywords (no free
> confidence baseline; name-token = 0.05 tie-breaker only). Probe 3: `responded: 7`,
> `strategy: bid`, trading-analyst claimed at 0.95 while shopping stayed silent. Also fixed
> along the way: `social.yaml` clobbered communications-bot's capability array (manifests now carry an
> identical union), and the legacy prefer-inline codex rule silently kept queue dispatches OFF the
> owner nodes (overridden per-owner with `requiresOwnNode`).

**Guiding rule:** an owner can only win a call-out if it is **ONLINE** (heartbeating), **EQUIPPED** (holds
its tools, or is a controller-prefed reason-only owner), and cleanly **DECLARED** (crisp one-line selector +
domain-scoped capabilities + natural-language keywords). A half-configured owner loses its bids silently.

---

## Owner readiness matrix (16 audited)

Legend — Online: ✅ heartbeating / ❌ offline (inline-on-api, cannot bid). Tools: ✅ complete / ⚠️ gap / ✅*by-design-zero (reason-only). Declared: ✅ clean / ⚠️ needs selector+keywords.

| Bot | agentId tail | Online | Tools | Declared | Primary fix |
|---|---|:--:|:--:|:--:|---|
| trading-analyst | …046 | ❌ | ⚠️ | ⚠️ | online; keywords/selector; forensics tool path (or narrow domain) |
| finance-analyst | …044 | ❌ | ✅* | ⚠️ | online; keywords + selector; keep zero-tool (pre-fed) |
| social-writer | …040 | ❌ (status=inactive) | ✅* | ⚠️ | online; keywords + selector; keep zero-tool |
| deck-builder | …042 | ❌ | ✅ | ⚠️ | online; keywords + selector |
| shopping-concierge | b007…001 | ❌ | ✅ | ✅ (strong selector) | online; rescope `preference-learning`/`checkout-handoff`; soften `target`/`order` |
| career-advisor | cb…002 | ❌ | ✅ | ⚠️ | online; keywords + selector; drop `cross-source-reasoning`; advisor≠worker |
| identity-advisor | …045 | ❌ | ✅* | ⚠️ | online; keywords + selector; keep zero-tool (pre-fed) |
| movies-concierge | b00b…001 | ❌ | ⚠️ | ✅ | online; register+grant TMDb tools; rescope `taste-learning` |
| spotify-concierge | b00a…001 | ❌ | ✅ | ✅ | online; drop `play`/`listen` keyword |
| travel-concierge | b00c…001 | ❌ | ✅ | ✅ (strong selector) | online; narrow `trip`/`airport` vs rides |
| storage-assistant | …041 | ❌ | ✅ | ⚠️ | online; keywords + selector; reconcile "Google Drive" claim |
| communications-bot | b000…001 | ✅ | ✅ | ⚠️ | selector + keywords; harness drift; drop meta-tags |
| home-bot | d000…001 | ✅ | ✅ | ⚠️ | **hydrate empty `computed_*`**; tighten `switch`/`scene` |
| cloud-ops-bot | d000…002 | ✅ | ⚠️ (0 tools) | ⚠️ | **grant `bash`**; drop `compute`/`devops`; scope `cost`/`audit` |
| eats-concierge | b008…001 | ✅ | ✅ | ✅ | rescope `preference-learning`; tighten `delivery` |
| rides-concierge | b009…001 | ✅ | ✅ | ✅ | rescope `preference-learning`/`trip-planning` vs travel |

---

## Phase 0 — Biddability (the unblock; do first, highest leverage)

- [ ] **Bring the 11 inline-on-api owners ONLINE / heartbeating.** They post no `oshal:runtime-agent:{id}`
  heartbeat, so the `BID_REQUEST` broadcast (`resolveOnlineAgentIds` → `buildStatusAwareOnlineResolver` =
  live heartbeats + DB status) never reaches them. Bots: trading-analyst, finance-analyst, social-writer,
  deck-builder, shopping-concierge, career-advisor, identity-advisor, movies-concierge, spotify-concierge,
  travel-concierge, storage-assistant. **Proof it's a per-bot seeding gap, not an inline limit:** sibling
  `codex-packer` (…0030), also inline-on-api, heartbeats (EXISTS=1). Choose one mechanism:
  - (a) seed a runtime-agent heartbeat per inline concierge (mirror codex-packer's registration), **or**
  - (b) extend the online resolver + bid transport to include inline-on-api personas in the call-out set.
  - Keep `recordCost → chat_tasks` firing on whichever transport wins (ADR-036).
- [ ] **social-writer:** DB `status=inactive` — flip to active *and* seed the heartbeat.
- [ ] **home-bot (online but broken):** `computed_capabilities` / `computed_routing_keywords` /
  `computed_selector_descriptor` are ALL EMPTY while `base_*` are populated. If the bid self-score reads
  `computed_*`, home-bot bids ~0 on smart-home and loses every call-out. **Run the selector-compute/sync
  step to hydrate `computed_*` from `base_*`** — and confirm which field (`base_*` vs `computed_*`) the bid
  self-score actually reads, then guarantee it's hydrated for *all* owners.
- [ ] **cloud-ops-bot:** grant the `bash` tool (agent_tools count=0). It shells out to
  `/app/scripts/oshal-gcp.js` + `oshal-gcp-diag.js`; works today only because the codex danger-full-access
  sandbox provides bash intrinsically — a strict tool-gate leaves it unable to execute. Do **not** grant
  interactive `gcloud` (persona deliberately avoids it).

## Phase 1 — Declarations (so bids are capability-based, not name-luck)

- [ ] **Replace persona-dump / empty `selector_descriptor` with a one-line "select when…"** for:
  trading-analyst, finance-analyst, social-writer, deck-builder, career-advisor, communications-bot,
  storage-assistant, identity-advisor. (The LLM router reads only `selector.split('\n')[0]` — today a
  mid-sentence fragment.) Use each bot's audited `recommendedSelector`; e.g.:
  - **communications-bot:** "Select when the user wants to read, summarize, triage, or draft replies to
    their email (Gmail or Outlook), review calendar/'my day'/agenda, or read inbox-forwarded social
    signals — never for sending/posting, SMS, or Slack/Teams." (Its rich selector currently lives in the
    *wrong* `email-bot.yaml` under a different agentId.)
- [ ] **Replace capability-tag-copy / empty `routing_keywords` with natural-language terms** for:
  trading-analyst, finance-analyst, social-writer, deck-builder, career-advisor, communications-bot,
  storage-assistant, identity-advisor, home-bot. Examples from the audit:
  - trading → `trading, trade, stock, equities, portfolio, position, autopilot, pnl, order, fill, risk-gate, backtest, buy, sell, hold, alpaca, schwab`
  - social-writer → `linkedin, x, tweet, thread, facebook, post, caption, draft a post, rewrite, hook, cta, personal brand`
  - career → `job, jobs, resume, cv, cover letter, application, apply, applied, recruiter, ats, interview, openings`
  - communications → `email, gmail, outlook, inbox, unread, my day, calendar, meeting, agenda, triage, draft reply, social signals`
  - storage → `repo, github, dropbox, google drive, storage target, files, save, backup, folder`
  - finance → `net worth, account balances, brokerage, plaid, spending, cash flow, budget, holdings`
  - identity → `connected accounts, logins, expired login, reconnect, duplicate accounts, default account`

## Phase 2 — Kill cross-domain collisions (stop over-bidding)

- [ ] **Rescope generic shared capability tags** (the main over-bidding driver):
  - `preference-learning` (4 concierges) → `purchase-preference-memory` (shopping), `cuisine-preferences`
    (eats), `ride-preference-learning` (rides), `traveller-preference-learning` (travel),
    `music-taste-learning` (spotify), `movie-taste-learning` (movies).
  - `checkout-handoff` (2) → `retail-checkout-handoff` (shopping), `uber-eats-checkout-handoff` (eats).
  - rides `trip-planning` → `rideshare-trip-planning`.
- [ ] **Drop broad non-domain capability tags:** cloud-ops `compute` + `devops` (keep only `gcp-*`);
  career `cross-source-reasoning`; communications operational meta-tags `oauth-preflight` +
  `dry-run-side-effects` (never appear in ticket text).
- [ ] **Fix concrete routing-keyword collisions** (the exact bug class):
  - `target` — shopping (retailer) vs storage `storage-target` → qualify storage to `storage-target`; let
    shopping match `walmart`/`amazon`, not bare `target`. **(This is the trading-audit → shopping bug.)**
  - `order` — shopping vs eats vs rides → soften shopping to `reorder`/`restock`.
  - `trip`/`airport`/`drive` — rides vs travel → `airport-ride`/`ride-to`.
  - `switch`/`scene`/`door`/`plug` — home vs git-switch/video-scene → `home scene`/`garage door`/`smart plug`.
  - `play`/`listen` — spotify vs video playback → drop `play`.
  - `watch`/`stream`/`tickets` — movies vs travel fare-watch/event tickets → `where-to-watch`/`showtimes`.
  - `cost`/`billing`/`audit` — cloud-ops vs finance/Vault → `gcp-cost`/`gcp-audit`.

## Phase 3 — The routing wiring (the only real code)

- [ ] **Delete `resolveTaskBotAgentId`** and the free-text `metadata.targetAgentId` pin in
  [jarvis-routes.ts](../../src/app/routes/jarvis-routes.ts) `dispatchHandoffs`. Jarvis files a
  well-described ticket + a `complexity` hint; it names no owner.
- [ ] **Route the `task` (fast) lane through the call-out:** in
  [dispatch-manifest-worker.ts](../../src/features/swarm-orchestration/services/dispatch-manifest-worker.ts),
  when no agent is pinned, run `MeshBidBroadcaster.broadcastBidRequest` (or `AgentRouter.route`) over online
  owners and dispatch to the lead via the **direct single-bot, no-decompose** tier
  ([queue-manager-service.ts:1857](../../src/features/swarm-orchestration/services/queue-manager-service.ts)).
- [ ] **Lane selection (flexibility):** use `AdaptiveComplexityService` + the bid outcome to keep fast vs
  **promote to the build/decompose lane** when no single owner claims the ticket, a capability gap is
  detected, or the ask is build-shaped. Jarvis's `complexity` hint biases; the QM decides.
- [ ] **De-weight the semantic name-token bid boost** in
  [extensions/swarm/index.ts:557-587](../../src/app/extensions/swarm/index.ts) so the self-score leans on
  the sharpened selector + domain-scoped capabilities, not raw name/keyword overlap (that boost is what
  relocates the misrouting).
- [ ] **Preserve the reason-only pre-fetch route (ADR-036):** finance-analyst, identity-advisor,
  social-writer, and trading-analyst (forensics) depend on the controller pre-folding their data context.
  They may **win the routing decision** but must **execute via the pre-fetch path** (controller assembles
  data → bot reasons), or be given callable data tools. A bare `BID_REQUEST` prompt must not strand them.
- [ ] **Verify accountability across the transport change:** `recordCost → chat_tasks` under the owning
  bot's `agent_id` still fires when an inline concierge is reached via the mesh call-out.
- [ ] **Define the low-confidence fallback:** no owner above threshold → a general tool-capable owner **or**
  one clarifying question. Never `project-manager`, never silent-escalate.

## Tool-registration gaps (ADR-025 auto-discovery not surfacing DB tools)

- [ ] **movies-concierge:** register the TMDb tools (`title-search`, `where-to-watch`, `recommendations`,
  `find-showtimes`, `watchlist-add`, `tmdb-accounts`, auto-discovered from `moviesToolKit.js`) in the `tools`
  catalog and grant via `agent_tools`; reconcile persona (`bash`/`fetch`/`google_search` = off) with the DB grant.
- [ ] **trading-analyst:** no order-ledger / risk-gate-audit / backtest tool exists, and it is reason-only
  (can't shell out to `oshal-trade-data.js` / `oshal-trade-ops.js` / `oshal-backtest.js`). Either register
  those CLIs as callable tools, **or** narrow its declared domain to the signal→decision contract so it
  doesn't win forensics call-outs it can't complete (forensics stays controller-fed).
- [ ] **Zero-tool BY DESIGN — leave alone (do NOT grant tools):** finance-analyst, identity-advisor,
  social-writer. Pure-LLM reasoning over controller-prefed data; social-writer must not shell out on the
  master-key api container.

## Decisions — LOCKED (operator, 2026-07-09) and implemented

1. **Biddability mechanism → (c) promotion.** Since Jarvis is the default concierge on every screen,
   the per-screen concierges don't need to live inline on the api at all — all 11 were promoted to
   **classic any-bot nodes** (own container, codex, heartbeating), the same treatment rides/eats got in
   ADR-050 (2026-06-20). The heartbeat comes free with a real node; no proxy mechanism was built.
   `general-bot` (a0…0099, persona everything-default.yaml) was added as a 12th node — the
   low-confidence fallback owner.
2. **Bid-field hydration:** the mesh bid self-score reads the node's **runtime identity**
   (compose `AGENT_CAPABILITIES`), now set to the cleaned tags; the AgentRouter keyword/score tiers
   read the DB candidates — `base_*` re-seeded from manifests/personas on app load, `computed_*`
   hydrated from `base_*` where empty (the home-bot fix), and both boot seeders now read
   `selector_descriptor`/`routing_keywords` from the persona instead of dumping prose.
3. **Bid window:** the full call-out runs on every task (the ~10s window is acceptable for async
   assistant tasks). No skip shortcut in v1 — Jarvis names no owner, so there is no "obvious single
   owner" signal to trust yet.
4. **Reason-only owners:** promoted onto the mesh like everything else. finance/trading gained
   READ-ONLY self-serve CLIs (`oshal-plaid.js` / `oshal-trade-data.js`) on their own nodes;
   identity-advisor stays zero-tool (its surfaces still pre-fetch via the direct-invoke path, which
   `executeBotOrInline` now transparently routes to the node).

## Missing owners (no bidder today — a separate build, not config)

`make me a video` (video/creative), `set up my store / process a payment` (payments/merchant),
`manage my secrets` / `run an RCA` (devops-Vault / IT-ops/RCA — cloud-ops covers only GCP), and general
web research / world-intelligence have **no knowledge owner** to bid. Track as roadmap; without an owner,
these asks must hit the defined fallback (Phase 3), not a wrong bot.
