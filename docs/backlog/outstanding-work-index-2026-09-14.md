# Outstanding-work index — 2026-09-14

A single index of every document across the two repositories that records unfinished work. It was
built by sweeping both trees by filename pattern **and** by content, because `**/HANDOVER.md` is
gitignored in core and `git ls-files` misses it.

This file is a **map, not a queue**. It does not restate done-when criteria — it tells you which
document owns a piece of work, how much is in it, whether the work is blocked, and whether the
document can still be trusted. The queues themselves remain authoritative:
[../BACKLOG.md](../BACKLOG.md) for the cross-cutting engineering queue, the per-area files indexed in
[README.md](./README.md), and each store package's own `BACKLOG.md`.

## Ground truth this index was checked against

| | value | verified how |
|---|---|---|
| core `main` | `9741111a` | `git log -1` on the trunk |
| deployed core image | `b8de2099` | `git log -1 b8de2099` → *"Merge pull request #431 from … feat/store-compatibility-gate"*; `git merge-base --is-ancestor b8de2099 HEAD` → true, 10 commits behind HEAD |
| store `main` | `64fb705` | `git log -1` in `oshal-applications` |
| core PR #431 (store compatibility gate / app dependency tiers) | **merged and deployed** | it *is* `b8de2099` |
| store PR #185 (package test-catalog pilots, scan-to-print 0.3.1, CAD-PLAN) | **merged** | merged into store `main` today |

**Nine documents still describe #431 and/or #185 as open, unmerged, or undeployed.** They are marked
STALE below. Do not act on their "land the PR first" instructions.

A git date of `2000-01-01 00:00:00 +0000` means the file has not been touched since the two
[ADR-115](../adr/115-clean-trunk-branch-strategy.md) trunk-cutover snapshot commits (`41d4784a`,
`3dbcac29`). It is reported here as *"untouched since cutover"*, not as a year-2000 date.

## Totals

- **76 documents surveyed**, of which **70 carry open work** (6 are clean or are evidence records).
- **882 open items counted** — every number below was counted, not estimated.
- That 882 is a **raw total and overstates the real backlog**, because several documents are
  indexes into others. The known duplication is enumerated in
  [Cross-references and double counting](#cross-references-and-double-counting); discount roughly
  60–90 items for it.
- Split: **653 in core**, **229 in the store repo**.
- The single largest queues are core [../BACKLOG.md](../BACKLOG.md) (260),
  [app-test-lab-registration.md](./app-test-lab-registration.md) (88), and the store's
  `marketing-engine/BACKLOG.md` (42).

---

## Core repo — the cross-cutting queue

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| [../BACKLOG.md](../BACKLOG.md) | the whole-platform engineering queue, 14 themed sections | **260 open, 0 done.** No id scheme — the `###` heading *is* the id; closed items are deleted by doctrine. 259 of 260 carry a `Done when:`; *"Cockpit startup: remove blocking external script dependencies"* has none and is structurally unclosable. 16 recent items use a newer `Context:` + criteria-sublist shape, so the file now has two formats. | mixed — ~30 need a deploy, ~18 an operator decision, ~13 hardware, ~20 a credential or billing | 2026-09-14 09:10 |
| [README.md](./README.md) | index for the per-area backlogs | 0 items, but **indexes only 14 of the 20 files in this directory**. Missing: `app-test-lab-registration.md`, `cockpit-startup-resilience.md`, `cockpit-workspace-navigation.md`, `enterprise-authorization.md`, `jarvis-daily-dashboard.md`, `next-priorities.md` — including the 88-item and 10-item queues | ready (docs fix) | 2026-09-14 09:10 |

Distribution of the 260 items in `../BACKLOG.md`: Promotion/deployment/regression proof 46 ·
Provisioning and operator experience 32 · Application-package follow-ups 31 · Shared product
experience 23 · Security/tenancy 20 · Connectors/channels 20 · Device/edge/spatial 19 ·
Workflow/agent/model runtime 17 · Video/creative 15 · Trading 13 · Animatronics and maker labs 12 ·
Career 5 · Token Chase 3 · Finance 3.

## Core repo — per-area backlogs (`docs/backlog/`)

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| [app-test-lab-registration.md](./app-test-lab-registration.md) | every installed package registering its own Test Lab catalog | **88 open checkboxes, 12 done.** `TLAB-01`–`TLAB-09` work orders with per-row done-when, plus a package worklist table and per-package `- [ ]` bullets. TLAB-07 and TLAB-08 wide open | partly — the sandbox proof needs Docker with VM 1-min load < 6 | 2026-09-14 03:04 |
| [artifact-exchange-continuation.md](./artifact-exchange-continuation.md) | ADR-139 "Send to…" rollout and three recurrence risks | **12 open.** Numbered 1–3 lists; the three risks each carry a `Done when:` | **ready** | 2026-09-13 22:39 |
| [bot-ui-db-persistence.md](./bot-ui-db-persistence.md) | moving bot UI tool registrations onto a durable `tools.ui` JSONB column | **6 open, 0 done.** Loose numbered 1–6 steps, no per-item done-when. Status says "Not started" | **ready** | untouched since cutover |
| [capture-crm-plugin-open-work.md](./capture-crm-plugin-open-work.md) | the `capture-crm` swarm-app plugin | **4 open, 1 done.** Numbered 1–5 "next session" steps, prose | partly — steps 3–5 need a live stack and an external Python board | 2026-09-11 12:44 |
| [cockpit-startup-resilience.md](./cockpit-startup-resilience.md) | cockpit boot failures; unexplained rollout-time Postgres pool-checkout stalls | **5 open, 1 delivered.** Prose with bolded `Remaining:` / `Done when:` paragraphs, no ids | **blocked** — needs a full fleet recreation and a correlated live trace | 2026-09-13 02:17 |
| [cockpit-workspace-navigation.md](./cockpit-workspace-navigation.md) | the workspace rail, OSHAL menu, Workspace skin | **4 open**, two sections already delivered. Numbered done-when lists per section | partly — installed acceptance is operator-gated; People/HR grouping is an explicit operator decision | 2026-09-13 00:19 |
| [education-content-sources.md](./education-content-sources.md) | free curriculum sources for the Little Monsters tutor | **4 open, 0 done.** Prose, numbered 1–4 ideas, no acceptance criteria | ready but **unscoped** — picking it up means inventing scope. Duplicates `lm-feature-backlog.md` Tier 2 | untouched since cutover |
| [enterprise-authorization.md](./enterprise-authorization.md) | ADR-149 enterprise authorization | **10 work orders open** (4 wholly, 6 partial) + 13 planned Lab case ids of which 1 is registered. `AUTH-01`–`AUTH-10` table with done-when/evidence | mixed — AUTH-04/09/10 need a live tenant, SCIM, canary; **AUTH-06 is ready** | 2026-09-12 18:01 |
| [government-contracting-crm.md](./government-contracting-crm.md) | the federal CRM / contract-management application | **5 open** ("Remaining acceptance and integration"), 8 delivery-scope items largely delivered. Prose bullets | **blocked** — installed acceptance, and most detail lives in the private application repo | 2026-09-11 23:54 |
| [hardening.md](./hardening.md) | the 2026-06-13 security/reliability audit, twice re-baselined | **7 open** (5 headline + 2 residuals) of 17. Numbered `#1`–`#17` with ✅/[DONE]/strikethrough | **4 of 5 blocked** — Headscale ACL apply, pre-auth key invalidation, credential rotation and node re-enrolment are live/operator acts. **#1 tenant scoping is ready** | 2026-08-06 |
| [haven-deferred-properties.md](./haven-deferred-properties.md) | ADR-030 persona properties and the ADR-079 deferred list | **4 open, 3 closed.** `###` items each with a `Done when:` | **ready** — every done-when is satisfiable with unit specs plus `MOCK_OIDC=true` | 2026-08-02 |
| [jarvis-daily-dashboard.md](./jarvis-daily-dashboard.md) | the compact daily Home page | **4 open** (JDX-03–JDX-06), 2 delivered. `JDX-01`–`JDX-06` table, priority + done-when | partly — JDX-04 needs live producer runtime; **JDX-03 and JDX-05 are ready** | 2026-09-13 01:26 |
| [jarvis-voice-and-visuals.md](./jarvis-voice-and-visuals.md) | Jarvis typed visuals, narration, ambient listening, diarization, wake-word companion | **11 open, 2 complete.** `JVV-001`–`JVV-013` with priority, status and done-when, plus 8 non-negotiable regression guards | mostly blocked — JVV-001 needs a test Gmail; JVV-004 real assistive tech; JVV-011 a signing cert and hardware; JVV-012 a vendor contract. **JVV-007/008/009 are ready** | 2026-09-11 23:22 |
| [lm-class-config-open-work.md](./lm-class-config-open-work.md) | Little Monsters class configuration | **3 open, 6 done.** Numbered 1–9 with done-when | partly — the spec *run* needs a `MOCK_OIDC` instance (prod is real-OIDC) | untouched since cutover |
| [lm-feature-backlog.md](./lm-feature-backlog.md) | the long-horizon Little Monsters wishlist | **27 open, 0 done.** Prose bullets under 19 headings across Tiers 0–5, plus 8 numbered ADHD gaps. No done-when anywhere | ready but **unscoped**; several sub-items are credential-gated | untouched since cutover |
| [next-priorities.md](./next-priorities.md) | the operator's 2026-09-11 ranked ten autonomous outcomes | **10 open**, all with the same status *"Source verified; checkpointed"*. Rank 1–10 table with an autonomous-acceptance column | ready by design — but it is an **index into three other docs** and its statuses have drifted from them | 2026-09-11 02:16 |
| [non-human-checklist.md](./non-human-checklist.md) | the "everything a bot can finish with no human" burn-down | **12 open `[ ]`, 14 done `[x]`, 6 `[H]` human-only.** Checkbox list with a legend, most items carrying an inline done-when | **9 of 12 ready**; 2 are self-flagged as actually human work, 1 needs a scope decision | 2026-08-09 |
| [store-dependency-tier-migration.md](./store-dependency-tier-migration.md) | converting store manifests to ADR-085 `required`/`optional` tiers | **7 open, 3 done.** Numbered 1–6 gated steps with strikethrough, a `[met]`/`[open]` done-when list, 4 related items all "(not started)" | partly — steps 2 and 6 need a signed-in browser and an install on the box; **step 5 and the 4 related items are ready** | 2026-09-14 11:01 |
| [test-lab.md](./test-lab.md) | the ADR-063 swarm build pipeline producing real deliverables | **7 open, 1 built, 1 half-done.** Two *overlapping* numbered lists (items 1–5 and recommendations 1–3), one global definition of done | partly — needs reconnected Google accounts and ≥4-of-5 clean nightly runs | 2026-09-10 21:40 |
| [trading-advisor.md](./trading-advisor.md) | signal-tuning and money-management defects in the trading advisor | **22 open, 0 done.** Numbered list grouped HIGH/MEDIUM/LOW, `Fix:` on every item | **8 blocked** (4 on paid feeds/billing, 4 gated behind #18). **14 ready** | 2026-09-13 23:03 |
| [archive/2026-09-11-context-reconciliation.md](./archive/2026-09-11-context-reconciliation.md) | nine claims moved out of `../BACKLOG.md` on 2026-09-11 | **1 open** (an optional, uncommissioned suggestion advisor); the rest are closed. Archive — should not change | blocked (uncommissioned) | 2026-09-11 01:30 |

## Core repo — roadmaps, handovers and plans

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| [../../ROADMAP.md](../../ROADMAP.md) | vision vs reality for the whole platform | **18 open rows** (8 In flight, 9 Planned, 2 code-health; one row already reads "target met" and should be deleted). `Item / Today / Target / Tracked in` tables | almost entirely blocked on vendors, hardware or live acceptance; the artifact-exchange row is ready | 2026-09-13 21:18 |
| [../../native/ROADMAP.md](../../native/ROADMAP.md) | the `native/` Rust/WASM numeric kernel (ADR-116) | **7 open.** Numbered 1–7, each with an italic `Done when:`, plus 5 explicit rejections | **items 1 and 3 are ready**; item 2 needs a quiet box and Linux; item 4 is blocked on item 5 | 2026-07-30 — **6½ weeks, the oldest doc surveyed** |
| `packages/oshal-vids-operator/BACKLOG.md` | the ADR-073 tool registry for the Google Vids operator | **12 open, 4 done.** Tasks 1–7 with P0–P3 and done-when on 1–6, plus a 1–5 Creative Studio residual list | **blocked** — task 1 is P0 *"needs your screen"*; one item needs `GEMINI_API_KEY`. Tasks 4–5 ready | untouched since cutover |
| `packages/oshal-vids-operator/HANDOVER.md` | the nightly trade recap failing daily since 2026-08-06 at `Enter-SharedNodeLease` (PowerShell 5.1 strips quotes from `--metadata-json`) | **5 open.** Numbered 1–5 "how to continue", prose | **items 1–3 ready**; item 4 blocked on the remote-client handover; item 5 is an operator decision | **untracked (gitignored)**, mtime 2026-09-13 23:06 |
| `src/features/remote-client/HANDOVER.md` | why `GET /api/remote-clients` returns zero nodes — retired shared secret, revoked node token, `::1` wslrelay wedge, `allowSystemControl:false` | **4 open.** Numbered 1–4, prose, no done-when | **blocked** — re-enrolment and turning on remote shell are operator acts | **untracked**, mtime 2026-09-13 23:06 |
| `src/features/trading/HANDOVER.md` | the live autopilot measuring its 5% stop against Schwab's wash-sale-adjusted basis, and adopting hand-placed positions | **4 open.** Numbered 1–4, prose + a cent-exact evidence table | **blocked on an operator decision that was never made** — see the time-critical note below | **untracked**, mtime 2026-09-13 23:08 |
| [../apps/unreal-mcp-worker-next-steps.md](../apps/unreal-mcp-worker-next-steps.md) | first bring-up of an Unreal MCP worker on a remote GPU PC (ADR-051) | **7 open** (4 "not done" + 3 operator questions), 5 done by inspection. Mixed bullets and a 1–7 procedure | **blocked** — no GPU/UE machine; plus an operator choice of which PC | untouched since cutover |
| [../apps/configurable-app-home-plan.md](../apps/configurable-app-home-plan.md) | per-user hide/reorder of App Home boxes, suites and metrics | **10 open** (5 unbuilt slices, 3 blockers, 2 deferred), 2 slices done. A 6-row done-when table | partly — the whole-store audit gate is red (12 errors) and one package owner is unlocated | 2026-09-09 22:42 |
| [../apps/ai-optimize-native-migration-plan.md](../apps/ai-optimize-native-migration-plan.md) | retiring the standalone ai-optimize app into a native Token Chase surface | **6 phases, claims "not started"** — see STALE below. Named Phases 1–6 with testable milestones | claims operator sign-off pending | untouched since cutover |
| [../apps/ai-plan-native-migration-plan.md](../apps/ai-plan-native-migration-plan.md) | retiring the standalone ai-plan Python app into a native planner | **6 open.** Phases 1–6, same shape | **blocked** — awaiting operator sign-off. *Its "not started" claim is accurate* (no `ai-plan` routes exist) | untouched since cutover |
| [../apps/career-hunter-native-migration-plan.md](../apps/career-hunter-native-migration-plan.md) | replacing the legacy Flask job-hunter dashboard with native surfaces | **3 open** connector-dependent follow-ons, 6 phases done | **blocked** — Dropbox, LinkedIn and Firecrawl connectors | untouched since cutover |
| [../architecture/drone-relay-expansion.md](../architecture/drone-relay-expansion.md) | expanding relay chains past a hovering line — perches, LoRa control plane, couriers, trees, lattices | **11 backlog ids + 6 operator questions + a 6-step order.** `B1`–`B11`, `Q1`–`Q6`, `R1`–`R5` | **blocked** — *"Nothing in this document has flown"*; the range test is the first act | 2026-09-13 22:58 |
| [../architecture/078-argo-batch-proveout-status.md](../architecture/078-argo-batch-proveout-status.md) | the ADR-078 local k8s/Argo batch prove-out ledger | **4 open** ("Still absent"); 17 adversarial defects fixed. Prose and claim/method/result tables, no ids | partly — a real in-cluster run needs a rebuilt image and tenant secrets; the Workflow-submitter half is ready | untouched since cutover |
| [../architecture/swarm-administration.md](../architecture/swarm-administration.md) | as-built swarm root / `swarm_roles` (ADR-148) and the multi-registry App Loader (ADR-147) | **6 open** (items 1, 2, 4–7; item 3 closed 2026-09-14). Numbered 1–7, each pointing at a `../BACKLOG.md` entry | **items 2, 4, 5, 6, 7 ready**; item 1 is an operator decision about installer root promotion | 2026-09-14 01:32 — **the freshest, and self-verified against code** |
| [../operations/bug-log.md](../operations/bug-log.md) | the interim Jira-ready bug log | **9 OPEN + 2 IN PROGRESS** of 24 (13 fixed, 4 of those with named residuals). `BUG-1`–`BUG-24`, no gaps, explicit three-value status | **8 of the 9 open are ready**; BUG-4 needs a healthy stack, BUG-23's residual an `ENCRYPTION_KEY` | 2026-09-14 01:28 |

## Core repo — runbooks that carry unfinished work

Of the 37 runbooks, **10 carry outstanding work**; the rest are complete procedures.
[deploy-parity.md](../runbooks/deploy-parity.md) is exemplary and has zero open items.

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| [../runbooks/jarvis-couldnt-do-that-just-now.md](../runbooks/jarvis-couldnt-do-that-just-now.md) | the Jarvis catch-all error — a text-vs-`UUID[]` ownership bind plus a bare `catch { return false; }` that 404'd every ask silently | **5 open** (3 "not proven yet" + 2 cleanup items owed on the box). Triage and guard tables with a status column, numbered 1–3, a 0–4 bash procedure | **was blocked on PR #431; that gate is now lifted.** Needs `scripts/oshal-deploy.sh` — *"there is no live workaround"* | 2026-09-14 01:27 |
| [../runbooks/local-ci.md](../runbooks/local-ci.md) | the local CI gate and the BUG-22 red streak | **4 open**, 3 done. Numbered items, each pointing at a `../BACKLOG.md` done-when. Prescribes its own order: *"2, then 1"* | **blocked on a quiet box** — *"a red night is not evidence about the code"* until exhaustion is reported distinctly | 2026-09-14 09:10 |
| [../runbooks/local-ci-bug22-run-2026-09-14.md](../runbooks/local-ci-bug22-run-2026-09-14.md) | the first kept CI run with spec-level output — 4 gates red | **0 own action items** (evidence only), but enumerates 45 failed unit files / 49 tests, 59 failed e2e, 5 security-policy failures, 1 blocking lint warning | **blocked** — captured on a host with 0.4–1.3 GB free RAM and 22 idle sessions | 2026-09-14 09:13 |
| [../runbooks/embodied-tile.md](../runbooks/embodied-tile.md) | driving the `embodied` package — explore/plan/execute, MuJoCo engine, the plant as a swarm-rail node, PX4 SITL | **4 open**, referenced as package ids B6, B20, B21, B22 | **blocked on a core decision** — ADR-149 enforce answers `401 authorization_identity_required` to the node's heartbeats. Drone and camera packages sit behind the same gate | 2026-09-13 22:15 |
| [../runbooks/a2a-gateway-local-enable.md](../runbooks/a2a-gateway-local-enable.md) | the single flip to enable the default-off inbound A2A gateway (ADR-109) | **3 open** — the flip itself is un-executed, plus 2 off-box residuals. Numbered preconditions 1–3, flip 1–2, verification 1–5 | **blocked** — needs a real third-party vendor agent and a TLS posture decision | untouched since cutover |
| [../runbooks/operations-stream.md](../runbooks/operations-stream.md) | the Prometheus → Alertmanager → incident → ticket pipeline | **2 open** core implementation gaps (`oshal_incident_snapshot` written only by replay; `claim_rule_id` NULL by design). Prose, no ids | **ready** — these are code gaps, not operator or hardware blocks | 2026-08-03 |
| [../runbooks/model-attribution-scrub.md](../runbooks/model-attribution-scrub.md) | the model-attribution trailer scrub | **3 open** — a push-time publish gate for trailers, no guard in the two application repos, and one operator decision about asking GitHub Support to purge unreachable objects | 2 ready, 1 operator decision | 2026-09-13 23:01 |
| [../runbooks/pre-deploy-checklist.md](../runbooks/pre-deploy-checklist.md) | the pre-deploy cycle | **2 open** despite a "CYCLE CLOSED" banner — a two-user RLS live test re-run with bots up, and a dev-password rotation. Also records a deploy **HELD** on 2026-09-09 because a concurrent session held the shared checkout | blocked — needs a live stack | 2026-09-09 01:44 |
| [../runbooks/market-remediation.md](../runbooks/market-remediation.md) | market-data remediation | **2 open**, explicitly scoped as non-blockers: per-bot GUC wiring (ADR-076 Phase 2) and tier-1 policies for ~8 lazy app-store tables | ready | untouched since cutover |
| [../runbooks/provider-profiles.md](../runbooks/provider-profiles.md) | provider profile selection | **1 open**, and it invalidates the runbook's own claim: *"A ticket that completes with a `grok-*` model attributed is the end-to-end proof this runbook is still missing"* | blocked — needs a live paid ticket run | 2026-08-12 |
| [../runbooks/update-check.md](../runbooks/update-check.md) | the update-check daemon | **0 open items**, but carries a stale hand-typed count — *"as of 2026-07-26 it applies to all 42 installed packages"* — against a repo whose bug log independently records 34 manifests. Re-derive before quoting | n/a | 2026-08-06 |

## Store repo (`oshal-applications`) — package backlogs

Paths are relative to `C:\Projects\oshal-applications`. These are **not** links: they live in a
different repository.

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| `marketing-engine/BACKLOG.md` | the whole marketing suite: audience store with consent/RLS, double opt-in, RFC 8058 unsubscribe, broadcast gate chain, sequences, SMS/10DLC, attribution, paid ads | **42 open, 0 done** (5 pickup steps + 37 phased entries across P0–P6 + cross-cutting). Every one carries both `Remaining:` and `Done when:` — verified 42 of each. The **largest open queue in either repo** | **blocked** — 3 entries are operator account steps (Resend domain + SPF/DKIM, Bluesky app password, DMARC `p=quarantine`); P0 is not on the box. P1–P6 code work is otherwise ready | 2026-09-14 09:38 |
| `embodied/BACKLOG.md` | the swarm/robot simulation lab — grasp geometry, scenarios, real perception, PX4 SITL, the MuJoCo plant, arm-in-the-room, learned policies | **16 of 23 open** (8 wholly, 8 with residuals; 7 done). `B1`–`B23` with `Today:`/`Done when:`, though listed out of order in the file | **blocked on one core decision** — B20/B22(b): core answers 401 to an `auth: service` node caller, *"and it is the operator's call"*. B19/B21 are compute-blocked (PPO, 3 seeds). **B2, B8–B12 ready** | 2026-09-14 03:23 |
| `scan-to-print/BACKLOG.md` | deterministic photo/LiDAR → mesh → print | **15 of 16 open** (B7 done in 0.4.0). `B1`–`B16`, prose + `Done when:` each | mixed — B15 needs a LiDAR phone, B14 the native scanner, B5 a real printer host, B16 an unset slicer env. **B1, B2, B8–B13 ready** — pure engine functions with synthetic fixtures already in-tree | 2026-09-14 02:58 |
| `circuit-lab/BACKLOG.md` | the ngspice electro-mechanical lab — firmware-in-the-loop, breadboard view, gear→CAD, shared parts model | **14 of 15 open** (6 wholly, 8 with residuals; B10 done). `B1`–`B10`, `B12`–`B16` — **there is no B11** | mixed — B3 needs a 3D print and a measurement, B13 an approved McMaster account, B12 an Onshape credential, B16 is held. **B2, B5, B6, B7, B9, B14 ready** | 2026-09-14 02:45 |
| `create/BACKLOG.md` | the creative workspace — layout, durable projects, image editing, AI regenerate loop, video timeline, brand kits | **14 of 15 open** (9 wholly, 5 partial; CREATE-EDIT-09 done) + 4 ordered next steps. `CREATE-EDIT-01`–`CREATE-EDIT-15` table with a done-when column | **blocked on the box and AUTH-07** — Docker engine down as of 2026-09-14 03:40 UTC; 1.8.0 rolled back to 1.7.1 because a release changing `authorization.yaml` cannot activate while an assignment holds the previous catalog revision | 2026-09-14 09:38 |
| `drone-relay/BACKLOG.md` | relay-chain planning — relay role, per-radio transports, link loss, corridors, trees, lattices | **9 of 11 open** (B7, B8 done in 0.3.0). `B1`–`B11`, prose + `Done when:` | mixed — B2 needs two ESP32 boards on a bench, B3/B10 depend on that measurement, B1 needs a core PR. **B4, B5, B6, B9, B11 ready** | 2026-09-14 01:41 |
| `aero-lab/BACKLOG.md` | certification of the persistent-flight lab — real-drive propulsion, engine resolution, the solar airship build | **9 open across 5 sections.** Lettered `A`–`E`, done-when on only 3 of 5 | **mostly blocked** — B is an explicit operator decision, C is materials (*"the 45 g/m² barrier film has no small-lot vendor"*), E needs a manual engine install on the box | 2026-09-13 23:02 |
| `animatronics/BACKLOG.md` | the ESP32/PCA9685 servo-prop package — firmware, camera→bearing tracking, servo dynamics, TALK from audio | **7 of 8 open** (B4 done). `B1`–`B8`, prose + `Done when:` | 3 of 7 need hardware (an ESP32 on a bench with a scope, a bus servo). **B3, B5, B6 ready** | 2026-09-14 03:52 |
| `cad-studio/BACKLOG.md` | the CadQuery/OCCT parametric kernel — revolve/sweep/loft, click-to-place, STL hand-off, threads, timeouts | **6 of 6 open, 0 done** — *"Nothing here is built."* `B1`–`B6`, one paragraph + `Done when:` each | **ready — the cleanest pick-up-with-just-the-repo file in either repo.** No hardware, no operator decision, no deploy | 2026-09-12 23:30 |
| `sports-edge/BACKLOG.md` | the odds maker — news wires into the line model, coach subjects, line-posting timing, staking gate | **4 of 5 open** (B done in 0.7.1). Lettered `A`–`E`, `Done when:` each. Unusually candid: *"A negative result closes this entry just as well as a positive one"* | mostly blocked — E needs an `espn-fantasy` connector row that does not exist; A and D need a completed season. **C is ready** | 2026-09-11 21:25 — oldest store backlog |
| `portrait-studio/BACKLOG.md` | camera-wiring coverage, wider Drive access for the photo picker, a store-wide browser-suite convention, local face detection | **3 open + 1 residual** (A closed, D done in 1.14.0). Lettered `A`–`E` with done-when on B, C, E | **blocked** — B is a two-way decision the package cannot make (Google Picker needs a core CSP change; `drive.readonly` is a security-boundary change); E needs a healthy box | 2026-09-14 09:46 |
| `career-hunter/BACKLOG.md` | **mis-named** — a release narrative for 1.21.0/1.20.0, not a backlog | **2 open** (portable test harnesses for five legacy groups; a pending package security audit). Prose only — no ids, no checkboxes, no done-when | ready but low-value | 2026-09-12 15:06 |
| `dnd/BACKLOG.md` | two governance repairs (file-size decomposition, a version pin) | **0 open** — both fixed 2026-09-14. The real dnd open work lives in `dnd/README.md` | n/a | 2026-09-14 10:17 |

## Store repo — continuation and plan documents

| path | covers | open items / shape | blocked? | last updated |
|---|---|---|---|---|
| `scan-to-print/docs/CONTINUATION.md` | the full scan-to-print handover — status, lineage, evidence map, module map, contracts, and an ordered pick-up sequence | **12 open** (7 ordered entries covering 15 BACKLOG ids, + 3 unproven items, + 2 unconfigured on the box). Numbered 1–8, referencing B-ids rather than restating criteria | mixed — its own #2 recommendation is hardware-blocked. Items #3–#7 are ready | 2026-09-14 02:58 |
| `circuit-lab/docs/continuing-0.7.0.md` | putting 0.7.0 on a box — firmware INPUT half, per-tick libngspice co-simulation | **7 open** (5 numbered install steps + 2 un-run suites) | **blocked on a deploy** — *"nothing here is installed"*; the engine image must be rebuilt (`libngspice0` is new), ~250 MB, then one api restart. Code is verified 45/45 | 2026-09-14 02:45 |
| `circuit-lab/docs/continuing-0.6.0.md` | putting 0.6.0 on a box — firmware OUTPUT half, avr8js + ngspice, the Jarvis surface-bridge rail | **8 open** (3 verification + 5 install steps) | **largely superseded** — the 39-case suite it says is unrun was later run green as 45/45 per `continuing-0.7.0.md`. Read 0.7.0 first | 2026-09-13 22:45 |
| `scan-to-print/CAD-PLAN.md` | the cross-package editable-CAD roadmap spanning scan-to-print, cad-studio and Create | **10 open, 0 closed.** `CAD-01`–`CAD-10` table with a `Done when` column — the cleanest done-when structure in the store | CAD-06 needs a licensed workstation; CAD-07 depends on scan-to-print B1/B2/B3. **CAD-01, -02, -05, -09 ready** | 2026-09-13 00:55 |
| `create/BRAND-KIT.md` | create 1.8.0's brand-kit slice — one private kit per person, read by AI Office/Portrait/Video | **8 open** (4 numbered next steps + 4 how-to-continue slices), plus 4 known limits | **blocked** — Docker engine down on the box; and AUTH-07 (a release changing `authorization.yaml` cannot activate while an assignment holds the previous catalog revision). Carries its own rollback path | 2026-09-14 09:38 |
| `video/EDITOR-PLAN.md` | the manual video editor — timeline model, owned media/revisions/exports, FFmpeg compiler | **5 open** delivery steps. Capability/gap tables + numbered 1–5 with done-when evidence. *"No manual video editor is installed or implemented by this document"* | step 1 is an approval gate; the FFmpeg feasibility proof is already green, so the rest is repo-ready | 2026-09-12 19:27 |

## Store repo — open work filed in package READMEs

Easy to miss because they are not named `BACKLOG.md`.

| path | open items / shape | blocked? |
|---|---|---|
| `dnd/README.md` §"Roadmap (next increments)" | **10 of 12 open** (2 struck as shipped). Numbered 1–12, prose. This is the *real* dnd queue — its `BACKLOG.md` has zero open items | mostly ready; item 4 needs a consent UX decision, item 9 a core `tvView()` change plus a Fire TV stick |
| `payroll/README.md` §"Still NOT built — deliberately" | **8 named gaps** — no e-file/EFTPS, only 4 verified state tables, no local/city taxes, no self-service, no 1099, no PTO accrual, no segregation of duties | **dangling pointer** — it says *"The backlog records each with a done-when"*, but **there is no `payroll/BACKLOG.md`**. That record does not exist |
| `game-show/README.md` §"Backlog — next steps" | **6 open**, numbered sparsely (1, 2, 6, 7, 8, 10) under P0/P1/P2, each with an explicit `Done when:` | heavily hardware-blocked — a laptop + two phones + a TV, a real mic, a desktop render node; #8 blocked on unreachable local infrastructure |
| `youtube-kids/README.md` §"Product backlog (canonical)" | **5 open** bullets — real Takeout/Dropbox acceptance, harvest privacy policy, YouTube scope expansion, more lenses, multiple children | **blocked on an operator/legal decision** — sensitive-scope verification, parental consent, child-data minimization and retention policy |
| `switchboard/README.md` §"Roadmap (next slices)" | **4 open** bullets, no ids, no done-when | one is blocked on the same X/LinkedIn media-upload follow-ups as marketing-engine P3; carving the three predecessor packages needs operator sign-off |
| `venture-plan/README.md` §"Next increments (not built)" | **4 open** bullets (a fifth is a deliberate refusal, not open work) | item 1 needs an authorized environment for forced-RLS/provider/scheduler evidence; items 2–4 are repo-ready |

---

## Stale and contradictory — read this before picking anything up

### Documents that describe merged PRs as open

All nine predate today's merges. `b8de2099` **is** the PR #431 merge commit and is an ancestor of
core `main`; store PR #185 is on store `main` at `64fb705`.

| document | the stale claim | reality |
|---|---|---|
| `marketing-engine/BACKLOG.md` (store) | *"Both PRs are open"*; pickup step 1 is *"merge store PR #185, then core PR #431"* | both merged. **Step 1 is done** — start at step 2. The deploy/recreate half is still genuinely outstanding |
| [app-test-lab-registration.md](./app-test-lab-registration.md) | *"None of it is deployed: the `src/` half needs a core deploy"* | #431 merged and deployed as `b8de2099` |
| [artifact-exchange-continuation.md](./artifact-exchange-continuation.md) | Stage 4a and the Jarvis leg *"were not on `main`"*, with a warning that *"rebuilding them would be waste"* | `src/app/routes/artifact-picker-routes.ts` is on `main` (commit `21ad8902`). **Its "highest-value next move" is already done** |
| [../runbooks/jarvis-couldnt-do-that-just-now.md](../runbooks/jarvis-couldnt-do-that-just-now.md) | the deploy must wait *"after PR 431 merges"* | **that gate is lifted.** Jarvis stays broken on the box until a deploy runs |
| [../architecture/drone-relay-expansion.md](../architecture/drone-relay-expansion.md) | pins work to both PR branches and instructs *"join them, do not mint another"* | following that now puts work on merged branches |
| `scan-to-print/docs/CONTINUATION.md` (store) | 0.3.1 and `CAD-PLAN.md` *"in flight on store PR #185"*; store `main` = 0.3.0 | #185 merged; the manifest in the tree now reads 0.4.0 |
| `scan-to-print/CAD-PLAN.md` (store), `create/README.md` (store) | reference #185 as in flight | merged |
| [../operations/bug-log.md](../operations/bug-log.md) BUG-22 | its newest note rests on a run of `231b76f4` of `feat/store-compatibility-gate` | a **pre-merge snapshot** of a branch merged today |
| [../runbooks/local-ci-bug22-run-2026-09-14.md](../runbooks/local-ci-bug22-run-2026-09-14.md) | 45 failed unit files / 49 tests / 59 e2e failures | measured on that same pre-merge branch head. **Re-measure against `main` before triaging from it** |

### Documents contradicted by the tree

- [../apps/ai-optimize-native-migration-plan.md](../apps/ai-optimize-native-migration-plan.md) says
  **"PLANNED, not started"**. The tree disagrees: `src/app/routes/optimize-routes.ts`,
  `token-chase-routes.ts`, `token-chase-promotion-routes.ts` and `src/features/token-chase/` all
  exist, `server.ts` mounts `/api/token-chase`, and `tests/optimizer-native-routing.spec.ts` asserts
  the cockpit Optimizer opens the native surface. **Do not start Phase 1 from this doc.** Its sibling
  [ai-plan-native-migration-plan.md](../apps/ai-plan-native-migration-plan.md) *is* accurate.
- [../apps/career-hunter-native-migration-plan.md](../apps/career-hunter-native-migration-plan.md)
  banner says *"Validated on real data; api stable"*. BUG-23 records Career Hunter AI scoring dead
  for 25 days behind two credential walls, with residuals still open.
- [lm-feature-backlog.md](./lm-feature-backlog.md) Tier 0 lists swarm-app manifests as
  *"HIGHEST PRIORITY … Target: Weekend of 2026-04-25/26 … requires ADR approval"*, naming
  `swarm-apps/`, a `swarm_applications` table, `SwarmAppService` and the `/api/swarm/apps` routes.
  **All of that shipped long ago** and is load-bearing for four sibling documents.
- [lm-class-config-open-work.md](./lm-class-config-open-work.md) flags itself:
  *"this list is a STALE DUPLICATE of the burn-down above — do not work it as written."* Reading it
  top-down past that warning means redoing six finished items.

### Documents that contradict each other

- [capture-crm-plugin-open-work.md](./capture-crm-plugin-open-work.md) still instructs an agent to
  run an external Python board at `:8787`, while
  [government-contracting-crm.md](./government-contracting-crm.md) says the native integrated CRM
  release is installed and replaces it. The second supersedes the first; the first does not say so.
- [store-dependency-tier-migration.md](./store-dependency-tier-migration.md) **contradicts itself**:
  its opening paragraph asserts *"No published package has been converted yet"* while its own status
  table says *"converted 2026-09-14 — all 61 tiered"*. It also attributes store PR #185 to the store
  authoring guide, whereas #185 is scan-to-print 0.3.1 + CAD-PLAN.
- `../BACKLOG.md` has **two items describing one nightly-gate streak with different counts** — one
  title says twelve nights, another entry says 46 runs.
- `../BACKLOG.md` disagrees with itself on the `@oshal/chat` version (one item says 0.3.0, another
  says the repo is at 0.4.0 while npm `latest` is 0.3.0).
- **Six headings** marked "Done already / Shipped" in
  [archive/2026-09-11-context-reconciliation.md](./archive/2026-09-11-context-reconciliation.md)
  still exist as live open items in `../BACKLOG.md` (surface theming, in-app help, trading watchdog
  D3.7, IPO playbook D6, strict-CSP D2 tail, cash-settlement D8 tail). The archive recorded a
  *sub-half* as shipped while the parent stayed open — grepping by heading gives two answers.
- `drone-relay/BACKLOG.md` (store) marks **B7 and B8 done in 0.3.0**;
  [../architecture/drone-relay-expansion.md](../architecture/drone-relay-expansion.md) lists
  B1–B11 as all outstanding. The package file is the newer of the two.
- [trading-advisor.md](./trading-advisor.md) has **broken numbering**: the list runs 1–20 but `5` and
  `6` are each used twice (HIGH #5/#6 collide with MEDIUM #5/#6), and the sequencing paragraph then
  cites "#1, #3, #7, #12". Anything numbered 5 or 6 needs disambiguating before it is assigned.
- [trading-advisor.md](./trading-advisor.md) header claims *"All items are paper-only until live
  sign-off"*, but its own HIGH #5 and #6 describe defects observed on a real book to the cent.

### Version drift between a doc and its manifest

`embodied/BACKLOG.md` tops out at 0.14.0 (manifest 0.15.0) · `portrait-studio/BACKLOG.md` says
1.14.1 (manifest 1.15.0) · `scan-to-print/docs/CONTINUATION.md` says 0.3.0 (manifest 0.4.0).

### Time-critical

`src/features/trading/HANDOVER.md` states *"The next regular-session fire is Monday 2026-09-14
09:30 ET"* and records that the operator was asked to choose between pausing the live leg,
ring-fencing, or fixing core — and **no choice was made; nothing is paused**. Core `main` was
committed at 12:15 ET today, so that fire has already passed with the decision still open. The
document's own caveat applies: its numbers are a 09-11/09-12 snapshot and must be re-verified.

---

## Ready to pick up now

Items needing **no operator decision, no hardware, no credential and no heavy compute**, ordered by
value for effort. Every one was read closely enough to confirm the classification.

| # | item | document | id | why it is ready |
|---|---|---|---|---|
| 1 | Deploy `main` | [../runbooks/jarvis-couldnt-do-that-just-now.md](../runbooks/jarvis-couldnt-do-that-just-now.md) | — | **Jarvis is fully down on the box.** The fix is in the tree with 4 of 5 guards green, and the only gate named — PR #431 — merged. *This is a deploy, so it needs a quiet box and is out of scope while the owner is trading; it is listed first because nothing else unblocks Jarvis.* |
| 2 | Close the artifact-exchange half-landed items and stop the waste warning | [artifact-exchange-continuation.md](./artifact-exchange-continuation.md) | rollout 1–3 | The picker is already on `main` (`21ad8902`); the remaining work is three source tags and four `accepts:` adapters, all repo-only |
| 3 | The whole cad-studio backlog | store `cad-studio/BACKLOG.md` | `B1`–`B6` | All six open, zero blockers, each with a `Done when:`. The single densest vein of unblocked work in either repo |
| 4 | Eight scan-to-print engine functions | store `scan-to-print/BACKLOG.md` | `B1`, `B2`, `B8`–`B13` | Pure engine functions with synthetic fixtures already in-tree from `renderDepth` |
| 5 | Multipart uploads lose the RLS request identity | [../BACKLOG.md](../BACKLOG.md) | *"Multipart uploads lose the RLS request identity"* | A security defect with a known fix shape — the helper and the red/green guard already exist in `spaces` 0.7.1; apply to the six core multer routes |
| 6 | `secret-scan` reports PASS when gitleaks could not read part of the tree | [../BACKLOG.md](../BACKLOG.md) | *"`secret-scan` reports PASS even when…"* | A fail-open security gate. `gate_secrets` inherits gitleaks' exit 0 on unreadable files; make it fail or name the degradation |
| 7 | Publish gate: refuse model-attribution trailers at push time | [../BACKLOG.md](../BACKLOG.md) | *"Publish gate: refuse model-attribution trailers"* | Extends `scripts/publish-gate.sh` check 5; red/green fixtures go in the existing `tests/unit/publish-gate.spec.ts` |
| 8 | The nightly can wedge for hours deleting its own previous export | [../BACKLOG.md](../BACKLOG.md) | *"The nightly can wedge for hours…"* | The replacement is already measured — a robocopy mirror-from-empty at 39 s against a 9 h `rm -rf` |
| 9 | Five swarm-administration continuation items | [../architecture/swarm-administration.md](../architecture/swarm-administration.md) | 2, 4, 5, 6, 7 | The freshest document surveyed, self-verified against code on 2026-09-13, and each item points at a `../BACKLOG.md` done-when. Only item 1 is an operator decision |
| 10 | Eight open bugs | [../operations/bug-log.md](../operations/bug-log.md) | `BUG-9`, `-10`, `-11`, `-14`, `-16`, `-17`, `-19`, `-20` | Repo-only, each with root cause and fix already written down in a Jira-ready field block |

Also ready, in the same class but narrower:

- **`jarvis-routes.ts` is over the decomposition threshold** (`../BACKLOG.md`) — 802 code lines
  against an 800 limit; a pure refactor with the target number stated.
- **Surface-glass spec is red on four page surfaces** (`../BACKLOG.md`) —
  `tests/unit/surface-glass-assets.spec.ts` already names `access`, `app-loader`,
  `jarvis-briefings`, `users`.
- **`MOCK_OIDC` truthiness — one predicate, three readings** (`../BACKLOG.md`) — `server.ts` tests
  `=== 'true'` in two places while `isMockOidcEnabled()` accepts `true|1|yes`.
- **Trading advisor items #1, #3, #7, #12** ([trading-advisor.md](./trading-advisor.md)) — the
  document's own recommended starting set; 14 of its 22 items are unblocked.
- **JVV-007, JVV-008, JVV-009** ([jarvis-voice-and-visuals.md](./jarvis-voice-and-visuals.md)) —
  JVV-007 includes replacing a floating `mermaid@11` jsDelivr import with a vendored pinned asset.
- **AUTH-06** ([enterprise-authorization.md](./enterprise-authorization.md)) — record- and
  field-scoped business data under FORCE RLS; real PostgreSQL, no external service.
- **Hardening #1** ([hardening.md](./hardening.md)) — tenant scoping for `personal_graph_*`,
  `chat_messages`, `agent_memories`, `knowledge_memory_documents`, `lm_*`. The only one of the five
  headline hardening items that does not need a live fleet act.
- **Operations-stream's two core gaps** ([../runbooks/operations-stream.md](../runbooks/operations-stream.md)) —
  `oshal_incident_snapshot` is written only by replay; `claim_rule_id` stays NULL by design.
- **`native/ROADMAP.md` items 1 and 3** ([../../native/ROADMAP.md](../../native/ROADMAP.md)) —
  item 1 is a single call site; item 3 either closes the 5–7× gap or retires the whole folder's
  existential question, unanswered for six weeks.
- **Store package work with no blockers**: `drone-relay` B4/B5/B6/B9/B11 (planner/simulation),
  `embodied` B2/B8–B12, `circuit-lab` B2/B5/B6/B7/B9/B14, `animatronics` B3/B5/B6, `sports-edge` C,
  `CAD-PLAN.md` CAD-01/-02/-05/-09.

### Cheap documentation fixes, all ready

- **Index the six missing per-area backlogs** in [README.md](./README.md) — including the 88-item
  `app-test-lab-registration.md` and the operator's own `next-priorities.md`.
- **Fix the duplicated numbering** in [trading-advisor.md](./trading-advisor.md) (5 and 6 each used
  twice) so items can be assigned unambiguously.
- **Retract the "PLANNED, not started" banner** on
  [../apps/ai-optimize-native-migration-plan.md](../apps/ai-optimize-native-migration-plan.md).
- **Add a `Done when:`** to the one `../BACKLOG.md` item that lacks one (*"Cockpit startup: remove
  blocking external script dependencies"*).
- **Resolve the self-contradiction** in
  [store-dependency-tier-migration.md](./store-dependency-tier-migration.md) and correct its PR #185
  attribution.
- **Create the missing `payroll/BACKLOG.md`** in the store repo, or correct the README that points
  at it.
- **Retire or cross-link the duplicate** between [education-content-sources.md](./education-content-sources.md)
  and [lm-feature-backlog.md](./lm-feature-backlog.md) Tier 2 — the same nine sources, twice.

## Blocked — grouped by what unblocks them

- **A quiet box and a deploy** (the single dominant blocker, ~40 items): circuit-lab 0.7.0's engine
  rebuild, create 1.8.0, marketing-engine P0, the aero-lab engine container, scan-to-print's slicer
  env, portrait-studio E's live tile, the Jarvis deploy, `local-ci`'s BUG-22 triage, and most of
  `../BACKLOG.md`'s "Promotion, deployment, and regression proof" section.
- **One core authorization decision**: `embodied` B20/B22(b) — core answers
  `401 authorization_identity_required` to an `auth: service` node caller. The drone and camera
  packages sit behind the same gate, and `create`/`video` hit its sibling AUTH-07.
- **Hardware**: two ESP32 boards on a bench (drone-relay B2, animatronics B2), a 3D printer
  (circuit-lab B3), a LiDAR phone (scan-to-print B15), a GPU PC (unreal-mcp), a GPU edge node
  (LoRA), a Mac and a Linux box (installer), a Fire TV stick (dnd 9), barrier film (aero-lab C).
- **Operator decisions** (~18 in `../BACKLOG.md` plus a dozen elsewhere): the trading stop-loss basis
  choice, arming a second autopilot leg, the trivy CVE budget, twelve colliding agent ids, the
  aero-lab engine tree, installer root promotion, People/HR grouping, the GitHub unreachable-object
  purge.
- **Credentials and billing**: `HF_TOKEN`, a test Gmail for JVV-001, an `espn-fantasy` connection
  row, an empty `ENCRYPTION_KEY` blocking codex promotion, Plaid/Stripe, Twilio A2P, a paid market
  history feed (trading-advisor #15–#18), an approved McMaster account, an Onshape credential, a
  Windows signing certificate.

## Cross-references and double counting

The 882 raw total includes these known indexes into other documents. Discount them when sizing:

- [next-priorities.md](./next-priorities.md)'s 10 items are a pure index into
  [enterprise-authorization.md](./enterprise-authorization.md),
  [app-test-lab-registration.md](./app-test-lab-registration.md) and
  [government-contracting-crm.md](./government-contracting-crm.md) — and its statuses have already
  drifted from them (ranks 3 and 4 are much further along than "checkpointed" suggests).
- `../BACKLOG.md` delegates the detail of `AUTH-*`, `JDX-*`, `CAD-*` and every store `B*` id to the
  sub-backlogs, so those items are counted in both places.
- [../architecture/drone-relay-expansion.md](../architecture/drone-relay-expansion.md)'s B1–B11 are
  the same ids as the store's `drone-relay/BACKLOG.md`.
- `scan-to-print/docs/CONTINUATION.md`'s seven ordered entries reference 15 ids already counted in
  `scan-to-print/BACKLOG.md`; both `circuit-lab/docs/continuing-*.md` do the same against
  `circuit-lab/BACKLOG.md`.
- [hardening.md](./hardening.md)'s web-control item states it is also tracked in `../BACKLOG.md`.
- [../runbooks/local-ci.md](../runbooks/local-ci.md) and its evidence file
  [local-ci-bug22-run-2026-09-14.md](../runbooks/local-ci-bug22-run-2026-09-14.md) both describe
  BUG-22, which is also an entry in [../operations/bug-log.md](../operations/bug-log.md).

## Method and limits

- Swept both trees by filename (`BACKLOG*`, `CONTINUATION*`, `continuing-*`, `HANDOVER*`,
  `*-continuation`, `NEXT*`, `TODO*`, `ROADMAP*`, `*open-work*`, `*remaining*`, `*next-steps*`) and
  by content (`Done when`, `TO CONTINUE`, `Remaining:`, `Next steps`, `not started`, `still open`,
  `Open questions`, `Not built`).
- Excluded `node_modules/`, `.git/`, and the `temp/` and `output/` staging trees in both repos —
  core's `temp/` alone holds ~200 copies of store package `BACKLOG.md` files from install staging,
  none of them canonical.
- Counts were taken by reading each document, then spot-verified with greps for the largest two
  (`../BACKLOG.md` 260 `###` headings outside code fences; `marketing-engine/BACKLOG.md` 42
  `###` / 42 `Remaining:` / 42 `Done when`).
- Dates come from `git log -1 --format=%ci -- <path>`, except the three gitignored `HANDOVER.md`
  files, which use filesystem mtime and are labelled untracked.
- **Not covered**: the private `oshal-app-private` repo, `docs/evidence/`, ADR bodies (only their
  status lines were consulted where a backlog item pointed at one), and the 18 records in
  `docs/releases/` other than `backlog-runtime-2026-09-11.md`. Several `../BACKLOG.md` items
  delegate their real acceptance criteria to ADRs, so their ready/blocked classification here rests
  on the backlog summary alone.
