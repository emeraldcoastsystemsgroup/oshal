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
- [x] **File-cap holdouts** — ✅ PR #29. The premise was BOTH stale and understated: `jarvis-ambient.js`
  was fine, but three OTHER files were genuinely over the cap and the gate could not see them —
  eslint's `max-lines` was scoped to `src/**/*.ts{,x}`, so an 1850-code-line `.mjs` (1.85x the cap)
  exited 0 for months. All three decomposed; `gate_lint` now lints `src tests scripts`, blocking.
  Not a core-file refactor after all — no `server.ts`/queue-manager decomposition was needed.
  <sub>superseded — the 2026-07-24 note this replaced, kept for context:</sub> **partly stale + wants review, NOT a blind bot.** `jarvis-ambient.js` is
  **466 lines, not 983**. ~15 files exceed 1000 *total* lines (server.ts 1639, swarm-app-service 1602,
  …) but the cap is *code* lines — needs the counts generator to find genuine violations, and
  decomposing core files (server.ts, queue-manager) is a reviewed refactor. **Deferred to a measured pass.**
- [ ] **Harden inline-controller bots — token-broker rollout phase 2** — still genuinely open (adjacent
  to the entitlement work; verify current state first — may be partly done).
- [ ] **swarm-cli zsh completion** — needs a real zsh to validate; likely `[H]` (a bot can generate it
  but can't prove it on interactive zsh).

## Wave 3 — larger builds, non-human but each needs a scoped design pass first

- [x] **Workflow Studio: run history + run inspector** — ✅ ALREADY BUILT; PR #21 closed the real
  residuals (runs panel scoped to the open workflow, run→cost-trace deep link, route-level authz
  guard, and a guard pinning that all three publish modes emit `pipeline: 'graph'`). Draft test-run is
  scoped OUT: it needs the studio compiler wired into the queue-manager, which CLAUDE.md forecloses.
  <sub>superseded — the 2026-07-24 note this replaced, kept for context:</sub> author→publish→execute exists;
  observability of a published run does not. Done-when: a published workflow's runs are listable +
  inspectable from the studio surface.
- [x] **Notification transports** — PR #26: notify slice already had 4 transports + a per-user router;
  added the real gaps — a severity→transport **policy**, an operator **email transport** (Gmail connector
  rail, no SMTP creds), an **inbound SMS webhook** (Twilio-signature-verified, route-auth allow-listed),
  and `/api/notify/alert`. 69/69 notification + 18/18 route-auth guards. Disabled-by-default, degrades clean.
- [x] **Cockpit surfaces for the shared services** (budgets / notify / DLQ / export) — ✅ PR #24. All
  four have read surfaces under `src/pages/cockpit/tools/`, bind-mounted (no rebuild), plus five
  route-level guard specs. Honest limits recorded: `/api/me` has no GET for stores/knownGaps or the
  audit trail; `spendUsd: null` renders as a dash, never `0`, because budgets fail open. One NEW small
  item fell out — the Settings "Cost Controls" localStorage decoy (relabel + link out, do NOT delete:
  it is the only control over that live state).
  <sub>superseded — the 2026-07-24 note this replaced, kept for context:</sub> they shipped
  headless; a surface makes composed processes observable. Done-when: each has a read surface.
- [x] **Graph adoption (ADR-045)** — ✅ PR #25 closed the backlog item so nothing stays in the
  ambiguous middle: RCA/capture personas given concrete graph recipes, three PHANTOM bots deleted
  (registry rows with no persona and no container), the seeded `graph-query` tool retargeted off dead
  Memgraph/Cypher onto `/api/graph`+AQL, a `uses:` declaration guard added CI-side, and `subgraph()`
  resolved as won't-build with a named revisit trigger. ONE item promoted to an open operator
  decision: `world-data` reaches the graph without being a kernel skill.
  <sub>superseded — the 2026-07-24 note this replaced, kept for context:</sub> the swarm operational graph + one domain carve so processes can
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

---

## 2026-07-29 second reconciliation — what the fleet actually found

**The burndown over-stated remaining work again, in the same direction as 2026-07-24.** Of the items
worked this pass, three were **already built** and the honest deliverable was the missing residual or
guard, not the feature: Workflow Studio run history/inspector, the `/api/me` Chroma+Arango exporters
(found in the earlier pass), and the route-audit `PUBLIC_BY_DESIGN` staleness (already fixed; the real
gap was the absent sync check). CLAUDE.md's anti-drift rule 4 is the lesson — "not yet built" about
shipped code costs the same credibility as the reverse, and it wastes a lane.

**The highest-value findings were not on this checklist at all.** They came from working *near* the
listed items:

- **Three separate holes in `.githooks/pre-push`** (PRs #20, #21, and a follow-up). The committed-HEAD
  typecheck had been silently skipping for **every agent-worktree push**, and
  `OSHAL_SKIP_PREPUSH_VERIFY=1` exited above the publish gate, so the documented override also
  disabled the leak wall on a public repo. Worktree isolation is now the standard way lanes run, so the
  default case for automated pushes was the publish gate and nothing else.
- **`persona-evals` was making a live LLM call from the controller** (PR #22), clearing none of the
  three budget/cost chokepoints and never reaching `chat_tasks` — the one LLM path that bypassed all
  of them.
- **`docs/security/SECURITY-HARDENING.md` claimed a reverted control** (PR #38). ADR-060's per-user
  path layout was implemented and then reverted, leaving only `// ADR-060 reverted to flat` comments,
  while the posture doc asserted filesystem isolation for about a month. Worse, `assertExistingTaskOwner`
  — the *entire* defense on the swarm path — had no test. It has ten now, mutation-proved.
- **`res.sendFile` dot-segment 404s** (PR #33) made two local-auth specs red *by default* for any
  worktree run, primed to be misattributed to the next agent's own change.

**A method note for whoever runs the next fleet.** Two "obvious" verification shortcuts are actively
wrong in this repo: (1) subject/PR-number matching against `main` cannot tell you whether a stale
branch landed, because the 2026-07-24 recreation kept content and discarded history — diff per file;
(2) `wc -l` is not the cap metric, and a cold `npm ci` makes unrelated specs fail on 5s timeouts, so
read `import` vs `tests` duration before calling a timeout a regression.

**Still genuinely open and non-human-doable** (each now has its own tracked entry in
`docs/BACKLOG.md`): the pre-push hook's remaining fail-open branches; `worktree-strays` being red by
design mid-flight; auditing the rest of the tree for `sendFile` dot-segment exposure; the Settings
cost-controls decoy; and the four orphan-boundary decisions (three with recommendations written up in
`docs/architecture/three-orphan-boundary-decisions.md`, which need an operator yes/no rather than a
bot).
