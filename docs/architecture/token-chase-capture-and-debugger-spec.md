# Token Chase — capture + debugger build spec (steps 1–2)

Implementation sketch for the **first shippable slice** of [ADR-046](../adr/046-token-chase-checkpoint-replay-optimization.md):
per-call capture, deterministic forward-only replay, and the **debugger view** (scrub / rewind /
step / hand-edit-and-continue). This is the substrate; the optimizer (assessor → corpus → policy)
is deliberately **out of scope here** — it bolts on top once replay reproduces baseline.

Grounded in the actual execution path (verified 2026-06-17). File:line references are the real hooks.

## Naming — do NOT collide with the existing "checkpoint"

`/api/checkpoints` already exists ([checkpoint-routes.ts](../../src/app/routes/checkpoint-routes.ts) →
`MemoryLayerService`). That is a **task-outcome memory snapshot** — coarse, Postgres-backed, restores
a whole `StoredTask` for the non-swarm memory layers. It is **not** what Token Chase needs and must
not be overloaded.

Token Chase's unit is finer (one per LLM call) and git-backed. Call it a **frame**. Route surface is
`/api/token-chase/*`; the per-call record is a `frame`; a full run is a `trace`. No reuse of the
`checkpoint` noun or the `memoryService` path.

## The execution path (where the hooks go)

| Concern | Location | Note |
|---|---|---|
| **Per-call chokepoint** | [AgenticController.js:382-391](../../any-bot/server/controllers/AgenticController.js) — `llmProvider.generateResponse(history, opts)` inside `processAgenticTask()` | The single wrap point. Everything is known here: `history` (full context in), `finalSystemPrompt`, `availableTools`, `task.workspace_dir`, `dynamicAgentId`, provider name, `swarmRunId`. The `response` (`.content`, `.contentBlocks`, usage) is known after. |
| **Workspace (git)** | `task.workspace_dir` — already `git init`'d per task by [GitLabService.js](../../any-bot/server/services/GitLabService.js) `createTaskProject()` | We extend the existing per-task repo with a commit *per call*, not a new repo. |
| **Cost** | `recordCost` → `chat_tasks` ([cost-tracking-service.ts:101](../../src/features/operational-intelligence/services/cost-tracking-service.ts)), keyed `taskId = ${baseTaskId}::${agentId}` | ⚠️ `chat_tasks` **aggregates per task** (`total_*`, `usage_by_model`), not per call. So the frame must capture **per-call** tokens from the `response.usage` itself; `chat_tasks` stays the canonical *task* rollup for reconciliation. |
| **Harness/model knowable at call time** | [provider-runtime.ts:67-150](../../src/app/composition/provider-runtime.ts) `HARNESS_RUNTIME_DEFAULTS` / `HARNESS_FACTORIES` | `{harnessType, model, providerName, binaryPath}` resolvable at the chokepoint → the frame's `decision{}` block. |
| **Route pattern** | [server.ts](../../src/app/server.ts) `app.use('/api/x', requiresAuth, createXRoutes(ctx))`; factory returns a `Router` taking `ctx: AppContext` | Token Chase routes follow this exactly. **Must be `requiresAuth`-gated** (exposes prompts/responses/workspace). |

Capture lives in the **bot-node JS execution layer** (AgenticController), not the controller — this
respects the controller/bot separation (CLAUDE.md): the bot owns execution, the controller orchestrates.
The frame is emitted from the bot and indexed on the TS side.

## Capture (step 1 → step 2)

Wrap the `generateResponse` call at AgenticController.js:382. Around each call:

**Before the call — write a frame commit:**
1. Serialize the call context to `<workspace>/.tokenchase/frame-<seq>.json`:
   ```
   { seq, taskId, agentId, swarmRunId, ts,
     context:  { history_ref, systemPrompt_hash, tools, input_tokens_est, query_type? },
     decision: { harnessType, model, providerName },
     pinned_reads: [...],        // any connector/RAG read this call depends on, frozen
     replayable: true|false }    // false if an unpinned live read precedes this call
   ```
   Store `history` itself as a blob (it can be large; truncation already happens at
   [AgenticController.js:370](../../any-bot/server/controllers/AgenticController.js) via
   `PromptTokenManager.safetyTruncate` — capture the **post-truncation** history, the one actually sent).
2. `git add .tokenchase && git commit` in `task.workspace_dir`. **The commit SHA is the frame id
   (`checkpoint_sig`).** This commit also captures whatever the workspace tree looks like pre-call.

**After the call — close the frame:**
3. Record the response + **per-call** usage (tokens_in/out from `response.usage`), latency, and write
   `frame-<seq>.response.json`. Commit again (or amend) so the frame holds both sides.

**The bot store (data version):** the bot's `user_sub`-keyed store snapshot ref goes in the frame too
(ADR-046 §1). For step 1–2, if the bot store isn't yet trivially snapshotable, capture a *ref/hash* and
mark frames that touch it — full store versioning can land with step 3.

**Index on the TS side:** a thin `token-chase` store (Postgres table or a JSON index) maps
`swarmRunId → ordered [frame SHAs]` plus the `chat_task_id` for the task, so the API can list a trace
without walking git. This is the only new persistence; everything heavy is git objects in the workspace.

## Replay — forward-only (the determinism gate)

`POST /api/token-chase/runs/:runId/replay { fromFrame, edit? }`:
1. Spin a **git worktree** off the `fromFrame` SHA (isolated dir, shared object store — cheap fan-out).
2. Rehydrate the sidecar: restore `history`, systemPrompt, pinned reads, bot-store ref.
3. Re-enter `processAgenticTask` at that call with the restored context. With **no `edit`**, assert the
   tail reproduces baseline (same response content / same resulting frames). With an `edit` (model,
   prompt, or a hand-supplied response), it's a counterfactual branch.
4. New frames append on the worktree branch; diff vs. baseline branch is `git diff` + the per-call
   token/cost delta.

**Step 2 is "done" only when no-edit replay reproduces baseline** for a `replayable` trace. Until then,
no variant is trustworthy.

## Route surface (`/api/token-chase/*`, all `requiresAuth`)

```
GET  /runs                      → list captured traces (runId, ticket, agent, #frames, total cost)
GET  /runs/:runId               → the ordered frame list (seq, SHA, decision, tokens, cost, replayable)
GET  /runs/:runId/frames/:seq   → one frame: full prompt-in, response-out, context, pinned reads
POST /runs/:runId/replay        → { fromFrame, edit? } → forward-only replay; returns variant runId + diff
GET  /runs/:runId/diff/:variant → baseline-vs-variant diff (artifacts + per-frame token/cost/latency)
```

Register in server.ts: `app.use('/api/token-chase', requiresAuth, createTokenChaseRoutes(ctx))`.

## The debugger view (the shippable deliverable)

A cockpit surface (`/api/token-chase/ui` static or a ribbon entry) over one trace:

- **Timeline rail** — one node per frame, left→right. Each shows seq, model/harness badge, tokens,
  $cost, and a marker for `replayable=false` (greyed, "rewind past me won't match").
- **Scrub** — click a frame → inspector shows the **exact prompt sent** (post-truncation history +
  system prompt), the tools offered, and the **response** (`content` + thinking `contentBlocks`).
- **Rewind + step** — select a frame as the "now"; step ◀ ▶ moves one call. "Play forward from here"
  triggers a no-edit replay (the determinism check, visible to the operator).
- **Hand-edit-and-continue** — edit the response text (or swap model) at the selected frame → "play
  forward" → side-by-side tail diff vs. baseline. This is the forensic move: *"if call 3 had returned
  this, would the tail be fine?"*

No assessor, corpus, or policy needed — this view is fully powered by steps 1–2.

## Determinism gotchas grounded in the real code

- **History truncation is already non-trivial.** `PromptTokenManager.safetyTruncate`
  (AgenticController.js:370) mutates `history` before the call. Always capture the **sent** history, or
  replay will assemble a different prompt and silently drift.
- **The Bedrock→Cline fallback path** (AgenticController.js:392-415) means the *harness that actually
  ran* can differ from the one selected. The frame's `decision.harnessType` must record the harness
  that **fired**, not the one requested, or counterfactual labels are wrong.
- **Per-call vs aggregate cost.** `chat_tasks` is a per-task rollup. Per-frame token/cost comes from
  `response.usage`; reconcile the sum against the `chat_tasks` row, don't read cost *from* it per call.
- **Non-determinism floor.** Even with identical input, temperature>0 / provider drift means "reproduces
  baseline" is *semantic*, not byte-exact, for some harnesses. The gate should compare on a tolerance
  (token count + a similarity/quality check), and frames known to be high-variance get flagged so the
  optimizer later weights them accordingly.

## Build order / done-when (mirrors BACKLOG)

1. **Step 1** — frame capture around AgenticController.js:382 + the TS trace index. Done when a real
   `incident-rca` run lists its ordered frames with per-call decision + per-call tokens, and links the
   `chat_task_id`.
2. **Step 2** — git frame-commits + worktree forward-only replay + **the debugger view**. Done when an
   operator rewinds to a frame, sees its prompt+response, plays forward with no edit and the tail
   reproduces baseline (within tolerance), and `non-replayable` frames are marked.

Ship the debugger at the end of step 2. The optimizer (ADR-046 steps 3–5) is a separate effort on this
same substrate.
