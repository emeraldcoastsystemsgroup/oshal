# Non-Human Burn-Down Checklist — everything machine-doable, tracked to zero

**Purpose (operator directive 2026-07-24):** *"get everything done that doesn't require a human."* This
is the living tracker for every item that a bot can finish WITHOUT a human in the loop. Each item has a
concrete done-when. Genuinely human items are listed separately at the bottom for reference — they are
**not** in scope for the fleet.

Legend: `[x]` done+merged · `[~]` in flight (bot assigned) · `[ ]` queued (non-human) · `[H]` human-only.

> **RECONCILIATION — 2026-07-24 ~23:00.** The fleet ran and it surfaced a real signal: **the burndown
> over-stated the remaining non-human work.** Multiple "open" items were **already built** — the bots
> correctly verified reality and, instead of duplicating shipped code, added the *guard that was
> actually missing*. **7 PRs merged this session (#19–#24, #26).** What genuinely remains is now mostly
> (a) larger design-heavy features, (b) a risky core-file refactor that wants review, or (c) human-gated
> flips — i.e. work that benefits from judgment, not more blind autonomous bots. Details inline below.

---

## Wave 1 — DONE

- [x] **Critical-path unit tests** — PR #21: `resolveHarnessForAgent`, swarm-app loader, `chooseDispatchPath` — 26 real specs, merged.
- [x] **Graceful-degradation sweep** — PR #20: found + fixed a *real* bug (graph runtime-unreachable threw an unhandled 500 → now a clean 503), harness error-logging, RAG BM25 fallback verified. 17 guards.
- [x] **Run-trace per-call tokens + durations** — PR #19: **ALREADY BUILT** (migration 090 shipped the columns; 948/1329 live rows carry token splits). Added the missing write-side guard.
- [x] **Bridge loop browser acceptance (ParentPC)** — DONE via desktop screen control: authenticated the real production cockpit, Workflow Studio + talk-to-build **proven live** (bot drew a full Draft→Approve→Deliver+Escalate graph). Loop-fix (talk-to-build fires the dock) built + deployed (PR #24, image `c488a04b`). Visual dock-render confirmation is the one residual `[H]` — the panel/dock render off the right edge of the 1536-wide leaf-node monitor, so operator eyes are the final tick.

---

## Wave 2 — DONE / reconciled

- [x] **Deep-import FSD violations** — PR: none (NO-OP). **Stale premise**: eslint reports **0** active
  barrel-boundary violations. The 12 remaining deep imports are *deliberate, documented, guarded*
  controller→LLM-runtime boundary exceptions (keeping the harness runtime off the controller graph);
  routing them through the barrel would break `controller-runtime-boundary.spec.ts`. Nothing to fix.
- [x] **JSDoc coverage on the large orchestration files** — PR #22: `dispatchTicket` had none + 2 drifted `@param`s; documented, comments-only.
- [x] **`/api/me` export gaps** — PR #23: **ALREADY BUILT** (Chroma + Arango exporters shipped 2026-07-19, caller-scoped, graceful). Added 10 behavioral guards.
- [x] **Unit tests for the remaining critical bits** — folded into PR #21 (the three named seams now have direct specs).
- [~] **File-cap holdouts** — **partly stale + wants review, NOT a blind bot.** `jarvis-ambient.js` is
  **466 lines, not 983**. ~15 files exceed 1000 *total* lines (server.ts 1639, swarm-app-service 1602,
  …) but the cap is *code* lines — needs the counts generator to find genuine violations, and
  decomposing core files (server.ts, queue-manager) is a reviewed refactor. **Deferred to a measured pass.**
- [ ] **Harden inline-controller bots — token-broker rollout phase 2** — still genuinely open (adjacent
  to the entitlement work; verify current state first — may be partly done).
- [ ] **swarm-cli zsh completion** — needs a real zsh to validate; likely `[H]` (a bot can generate it
  but can't prove it on interactive zsh).

## Wave 3 — larger builds, non-human but each needs a scoped design pass first

- [ ] **Workflow Studio: test-run + run history + run inspector** — author→publish→execute exists;
  observability of a published run does not. Done-when: a published workflow's runs are listable +
  inspectable from the studio surface.
- [x] **Notification transports** — PR #26: notify slice already had 4 transports + a per-user router;
  added the real gaps — a severity→transport **policy**, an operator **email transport** (Gmail connector
  rail, no SMTP creds), an **inbound SMS webhook** (Twilio-signature-verified, route-auth allow-listed),
  and `/api/notify/alert`. 69/69 notification + 18/18 route-auth guards. Disabled-by-default, degrades clean.
- [ ] **Cockpit surfaces for the shared services** (budgets / notify / DLQ / export) — they shipped
  headless; a surface makes composed processes observable. Done-when: each has a read surface.
- [ ] **Graph adoption (ADR-045)** — the swarm operational graph + one domain carve so processes can
  reason across apps. Done-when: one real ingestion + NL-query path over the existing connector.
- [ ] **Chat-channel surfaces** — Telegram inbound shipped → Discord / WhatsApp inbound so processes
  kick off from outside the cockpit. Done-when: one additional channel delivers an inbound message.
- [ ] **Global search** — deep-link contract + `pg_trgm` indexes (connective tissue for the home view).
- [ ] **Combined "home" view** — compose across apps instead of `?app=` silos (operator ask). *Needs a
  layout design decision first (a human input) — flag before building.*
- [ ] **Guide bots that drive their app** — bot-driven walkthrough of a multi-step process (now that
  the chat↔surface bridge is live, this is buildable on top of it).
- [ ] **Mobile-responsive sweep** — extend the pinned-header / single-scroll-child pattern + a viewport
  test across surfaces.
- [ ] **Whole-app surface validation sweep** — explicitly *required before the polished-SaaS claim*.
- [ ] **Repeatable self-hosted local-LLM swarm profile** — Ollama/LM Studio/LiteLLM are wired; no
  documented all-local profile + benchmarks. Done-when: a profile boots the swarm fully local + a
  benchmark doc.
- [ ] **Consolidate the dual/tri runtime** → one canonical AnyBot node runtime with full parity to the
  TS tool/provider registries. Large; ADR-level.
- [ ] **Token Chase Step 5** — heuristic → trained selection policy from the accumulated corpus (the
  keep-winner loop is the deterministic precursor).
- [ ] **Agentic authoring** — compose brand-new agents/goals/personas from an NL description (talk-to-
  build drafts the graph over *existing* bots; this is the missing half). *Needs a scope decision.*

## CI / infra (machine-doable subset)

- [ ] **CI Playwright e2e normalization** (~132 specs; baseURL conventions) — Done-when: the suite runs
  clean under one baseURL convention.
- [ ] **`deploy.yml` deploys to the ephemeral runner, not a real environment** — Done-when: either a
  real target is wired (needs an environment → may be `[H]`) or the job is honestly scoped/disabled.

---

## Human-only — NOT fleet scope (listed for completeness)

- [H] Credential pastes: Twilio SID+token · Plaid client/secret · Stripe test key · Telegram BotFather
  token · Kalshi demo · Azure/Outlook app · X API Basic tier · Google CSE id · `SWARM_SERVICE_SECRET`.
- [H] Hardware / accounts: local-LLM GPU tier · GPU edge box for LoRA · a real host/cluster for ops
  bots · bias datasets.
- [H] Spend-consent live smokes: Token Chase golden-scenario eval-wall refresh · identity-leg live
  smoke · the multi-night golden nightly soak · verify-to-live (Finance/Plaid, Kid Lens, LoRA, Vids,
  Comms phone/text, Video Series, Telegram notify).
- [H] Deploy-time flips: `guc-strict` warn→deny · `OSHAL_EXECUTE_ENTITLEMENT=enforce` ·
  `OSHAL_PUSH_ON_DISPATCH` · `A2A_GATEWAY_ENABLED` · headscale ACL apply · edge-node re-enrollment.
- [H] Registry installer fresh-install VM trial · public-launch gate + CI secret-scan proofs.
- [H] OAuth app reviews: Gemini one-click login · Kid Lens `youtube.readonly` verification · SmartThings
  OAuth client · Plaid · Azure/Outlook.
