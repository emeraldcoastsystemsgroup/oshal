# Skill registry + app→skill matrix  *(DERIVED — evidence for ADR-090)*

**Generated: `node scripts/skill-inventory.js`. Re-run after every carve.**

This is **evidence, not a decision.** Tiers below are *proposals* computed from real usage;
the classification is the operator's call ([ADR-090](../adr/090-skills-as-first-class-packages.md)).

**Two ways a route reaches a capability — both are counted:**
1. **`@/features/<x>` import** — what a *carved package* does (little-monsters imports
   `presentation-generation` + `voice-providers` at runtime today).
2. **`ctx.<service>`** — the AppContext handed to every route factory. **AppContext is the
   de-facto kernel-skill API already** — see §3; formalizing it *is* Wave-0 item D8.

**Reading the tiers:** `≥2 apps` → **kernel skill** (Tier-0b). `exactly 1 app` → **app-owned
candidate**: vendor it into that package on carve (the google-calendar lesson) *unless* you
expect a second consumer — then publish it as a **skill package** rather than bury it
(the ADR-090 shareable-skill case). `core-only` → platform internals, never carve.

> **Blind spot:** 14 apps expose no server routes and reach skills via bots/tools
> instead. They are flagged in §2 and need a manual pass (persona `allowed_tools` + manifest `tools:`).

## 1. Skill registry — every feature, its consumers, a proposed tier

| Skill (`src/features/`) | Apps importing it | # | Core? | Proposed tier | Basis |
|---|---|---|---|---|---|
| `agent-management` | `eats`, `finance`, `home`, `identity`, `jarvis`, `oshal-engineering`, `rides`, `social`, `storage`, `video`, `youtube-kids` | 11 | yes | **KERNEL SKILL** | 11 apps import it |
| `agent-profile` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `ambient-listening` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `chat` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `chat-channels` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `chat-orchestration` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `claude-code-auth` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `config-sync` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `demo-mode` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `dev-console` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `edge-agent` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `google-calendar` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `governance` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `graph` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `haven` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `intake` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `llm-provider` | `little-monsters` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `logging` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `lora-studio` | `lora` | 0 | no | CARVED 2026-07-17 | vendored into the lora store package as predicted (ADR-085 Wave 1 carve #3) — the slice no longer exists in core |
| `memory` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `notifications` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `openai-codex-oauth` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `operational-intelligence` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `payments` | (store packages: `finance`, `payments`) | 0 core | **yes — PINNED 2026-07-17** | **KERNEL SKILL (contracted)** | 11th declared skill: both importers carved to the store (ADR-085 #4/#5); the D8 anchor + CI guard now hold it in dist |
| `personal-data` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `personal-graph` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `presentation-generation` | `little-monsters` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `process-lab` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `rag` | `little-monsters` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `rca-analysis` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `remote-client` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `saas` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `scheduling` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `security` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `selector-composition` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `skill-import` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `speaker-diarization` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `streaming` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `surface-bridge` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `swarm-apps` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `swarm-orchestration` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `task-explorer` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `ticketing` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `token-chase` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `tool-approval` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `tool-integrations` | `presentations` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `tool-loader` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `tool-registry` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `tool-switch` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `tool-verification` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `trading` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `ui-profile` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `user-model` | `jarvis` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `video-generation` | `video` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `visual-response` | `jarvis` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `voice` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `voice-providers` | `little-monsters` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |
| `workflow-studio` | `oshal-engineering`, `workflow-studio` | 2 | yes | **KERNEL SKILL** | 2 apps import it |
| `workspace-bootstrap` | — | 0 | yes | KERNEL (platform) | core-only — never carves |
| `workspace-sandbox` | — | 0 | no | UNUSED? | no importer found — verify (may be CLI/script-only) |
| `world-data` | `world` | 1 | yes | KERNEL SKILL? | 1 app + core — decide: shared service or app-owned |

## 2. App → skill matrix

| App | `@/features` imports | `ctx.*` services used | Note |
|---|---|---|---|
| `brand-graphics` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `capture-crm` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `career-hunter` | — | `pool`, `ticketService` |  |
| `cloud` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `codex-packer` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `creative-studio` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `daily-trade-recap` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `devops` | — | — |  |
| `eats` | `agent-management` | `orchestrator`, `pool` |  |
| `email-summarizer` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `federal-capture` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `feeds` | — | `pool` |  |
| `finance` | `agent-management`, `payments` | `pool` |  |
| `gov-contracting` | — | — |  |
| `home` | `agent-management` | `pool` |  |
| `identity` | `agent-management` | `pool` |  |
| `intelligent-operations` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `intelligent-processing` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `intelligent-trades` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `jarvis` | `agent-management`, `user-model`, `visual-response` | `messageStore`, `orchestrator`, `pool`, `swarm`, `taskStore`, `ticketService` |  |
| `job-apply` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `little-monsters` | `llm-provider`, `presentation-generation`, `rag`, `voice-providers` | `pool`, `ticketService` | CARVED to the store — scanned from its package src-routes/ |
| `lora` | `lora-studio` | `pool`, `ticketService` |  |
| `movies` | — | `orchestrator`, `pool` |  |
| `oshal-dev` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `oshal-engineering` | `agent-management`, `workflow-studio` | `memoryService`, `messageStore`, `taskStore`, `workspaceBootstrapService` |  |
| `payments` | `payments` | `pool` |  |
| `presentations` | `tool-integrations` | — |  |
| `purchasing` | — | `orchestrator`, `pool` |  |
| `rides` | `agent-management` | `orchestrator`, `pool` |  |
| `security-center` | — | — | ⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass |
| `social` | `agent-management` | `pool` |  |
| `spotify` | — | `orchestrator`, `pool` |  |
| `storage` | `agent-management` | `pool` |  |
| `travel` | — | `orchestrator`, `pool` |  |
| `video` | `agent-management`, `video-generation` | `pool`, `swarm`, `ticketService` |  |
| `vids` | — | `pool` |  |
| `workflow-studio` | `workflow-studio` | — |  |
| `world` | `world-data` | — |  |
| `youtube-kids` | `agent-management` | `pool` |  |

## 3. AppContext — the de-facto kernel-skill API (D8)

Every route factory receives `ctx`. Its fields ARE the capability surface core already
hands to apps — an uncurated, undeclared kernel API. **D8 should formalize THIS**, not
invent a new barrel: decide which fields are a stable, package-callable contract, and which
are platform internals a package must never touch.

Exposed today (27): `taskStore`, `messageStore`, `streamManager`, `orchestrator`, `provider`, `getProvider`, `pool`, `toolController`, `agentProfileController`, `agentToolController`, `swarm`, `toolRegistryService`, `dynamicToolExecutorRegistry`, `runtimeToolRegistrationService`, `connectorMarketplaceService`, `connectorSpecToolService`, `switchFrameworkService`, `selectorCompositionService`, `verificationController`, `verificationScheduler`, `memoryService`, `workspaceBootstrapService`, `ticketService`, `ticketProjectAssignmentService`, `workspaceService`, `planeSyncService`, `ticketInteractionService`

| `ctx` service | Apps using it | # |
|---|---|---|
| `ctx.pool` | `career-hunter`, `eats`, `feeds`, `finance`, `home`, `identity`, `jarvis`, `little-monsters`, `lora`, `movies`, `payments`, `purchasing`, `rides`, `social`, `spotify`, `storage`, `travel`, `video`, `vids`, `youtube-kids` | 20 |
| `ctx.orchestrator` | `eats`, `jarvis`, `movies`, `purchasing`, `rides`, `spotify`, `travel` | 7 |
| `ctx.ticketService` | `career-hunter`, `jarvis`, `little-monsters`, `lora`, `video` | 5 |
| `ctx.messageStore` | `jarvis`, `oshal-engineering` | 2 |
| `ctx.swarm` | `jarvis`, `video` | 2 |
| `ctx.taskStore` | `jarvis`, `oshal-engineering` | 2 |
| `ctx.memoryService` | `oshal-engineering` | 1 |
| `ctx.workspaceBootstrapService` | `oshal-engineering` | 1 |

## 4. Summary

- **3** skills imported by 2+ apps → **kernel-skill candidates**: `agent-management`, `payments`, `workflow-studio`
- **10** imported by exactly 1 app → **app-owned candidates** (vendor on carve, or promote to a skill package if a 2nd consumer is expected).
- **41** core-only → platform internals.
- **7** with no importer found → verify (CLI/script-only, or dead).
- **40** apps inventoried; **14** need the manual bots/tools pass: `brand-graphics`, `capture-crm`, `cloud`, `codex-packer`, `creative-studio`, `daily-trade-recap`, `email-summarizer`, `federal-capture`, `intelligent-operations`, `intelligent-processing`, `job-apply`, `oshal-dev`, `security-center`, `intelligent-trades`

