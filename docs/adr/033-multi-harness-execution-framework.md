# ADR-033: Multi-Harness Execution Framework

**Date:** 2026-04-13
**Status:** Accepted
**Author:** maintainer@emeraldcoastsystemsgroup.com

---

## Context

The swarm previously used a single execution path for all bots: the Cline CLI harness routing to a single hosted provider (gpt-4.1). This created a hard coupling between execution harness and provider — there was no clean way to run a specific bot against a different LLM (e.g., Claude Code via Anthropic) without global overrides that would affect all bots.

Two concrete requirements drove this change:

1. `code-reviewer` should use `claude --print` (Anthropic direct) for high-quality code review
2. Cost tracking must attribute tokens to the correct provider and model per bot, not as a single global cost bucket

---

## Decision

Per-bot harness selection via a registry declaration. Each bot in `swarm-bot-registry-local.ts` declares:
- `harnessType` — which execution path to use: `'cline' | 'claude-code' | 'noop'`
- `apiType` — which provider backs it: `'claude-code' | 'openai' | ...`

Boot sync on every API startup writes `harnessType`/`apiType`/`modelId` from registry to DB via `syncProviderModel()`. This ensures DB never drifts from registry, regardless of what was last saved via the Config UI.

At read time, `enrichProfileWithHarness()` in `agent-profile-controller.ts` joins registry data into profile API responses without a DB schema change — `harnessType` and `apiType` are injected at the controller layer.

The active registry is selected via `SWARM_REGISTRY` environment variable:
- unset, `local`, or any stale/unknown value → `LOCAL_BOT_REGISTRY`, the current deployment and
  authoritative identity/capability/harness definition
- `full` → a deterministic superset of that local authority plus the six non-colliding historical
  catalog-only identities; a shared UUID can never redefine the local record
- `kernel` → the UUID-filtered kernel-required subset of the same local authority

Installed application packages append their dynamic bot declarations in every mode. CI guards
unique UUID/name identity, exact local-to-full shared records, kernel parity, the six-entry full-only
allow-list, selector fallbacks, and dynamic append behavior.

The `getActiveRegistry()` function must be used everywhere (not `SWARM_BOT_REGISTRY` directly) to respect this env var.

---

## Harnesses

### `cline`

Spawns `cline --json` as a subprocess. Token data read from `ui_messages.json` after process completion (stdout stream does not carry token data). Provider/model resolved from `FORCE_LLM_PROVIDER` / `FORCE_LLM_MODEL` env vars or from per-bot `apiType` in the registry.

### `claude-code`

Spawns `claude --print` as a one-shot subprocess. Authenticates via VSCode OAuth session at `~/.claude` (mounted read-only into containers). Returns JSON on stdout including `usage.input_tokens` and `usage.output_tokens`. `ClaudeCodeCliHarnessAdapter` parses these for real cost tracking. One-shot means no file tools; workspace write is not available.

---

## Cost Tracking

Each harness adapter returns a `UsageSummary` with real token counts where available. `CostTrackingService` persists to `chat_tasks`. `ticket_task_links` enables per-ticket tree rollup. The cost-resolver already had claude-sonnet-4-6 pricing via `findClaudeFamilyPricing()` (substring "sonnet" → $3/$15 per million tokens). The OperationsView `_renderCostByModel()` displays per-model cost breakdown using `qmActivity.modelUsage`.

---

## Consequences

**Positive:**
- Different bots can use different LLMs without global overrides
- Cost is tracked and attributed per-provider across the same ticket
- Registry is the single source of truth for harness/model — DB always matches on restart
- UI shows correct harness/api/model per bot in Config Admin and OperationsView

**Negative:**
- Claude Code bots are one-shot only (no interactive tools)
- Boot sync adds latency on first API request if registry is large
- `SWARM_REGISTRY` env var must be set correctly — wrong value silently uses wrong registry

**Neutral:**
- Adding a new harness type requires implementing `HarnessAdapter` interface + adding a factory entry in `HARNESS_FACTORIES` map
- The `listDefinitions()` fix (using `getActiveRegistry()` instead of hardcoded `SWARM_BOT_REGISTRY`) was required to propagate `harnessType`/`apiType` through the registry API endpoint to OperationsView

---

## Files Changed

| File | Change |
|------|--------|
| `src/app/extensions/swarm/swarm-bot-registry-local.ts` | Added `harnessType` + `apiType` per bot |
| `src/app/extensions/swarm/swarm-bot-registry.ts` | Fixed `listDefinitions()` to use `getActiveRegistry()` |
| `src/app/extensions/swarm/index.ts` | Added boot sync loop on startup |
| `src/entities/agent/repositories/agent-profile-repository.ts` | Added `syncProviderModel()` |
| `src/features/agent-profile/controllers/agent-profile-controller.ts` | Added `enrichProfileWithHarness()` |
| `src/pages/cockpit/js/views/OperationsView.js` | Full rewrite — harness attribution + cost-by-model |
| `src/pages/config-admin/config-admin-agent-panel.js` | Shows Harness / API / Model per agent |


---

## Updates

### 2026-04-25 — `gemini-cli` harness added

Google `@google/gemini-cli` v0.41.2+ joined as a fourth standalone CLI
harness alongside `codex-cli`, `claude-code`, and `cline`. Authentication
prefers the `GEMINI_API_KEY` env var (Google AI Studio key) and falls
through to the OAuth session at `~/.gemini/` from `gemini auth login` on
the host (mounted into containers like `~/.codex` and `~/.claude`).

Verified flag set: `gemini --skip-trust -m <model> [-o json] -p "<prompt>"`.
There is no `--system` flag — system prompts are prepended to the user
prompt by the adapter.

Files touched:
- `src/features/llm-provider/services/harness-adapter.ts` — `'gemini-cli'` added to `HarnessType` union
- `src/features/llm-provider/services/gemini-cli-harness-adapter.ts` — new adapter
- `src/app/composition/provider-runtime.ts` — factory entry + modelId/binary chain arms
- `src/app/extensions/swarm/swarm-bot-registry-local.ts` — `research-bot` switched to `gemini-cli`
- `Dockerfile.oshal` — `npm install -g @google/gemini-cli@latest`
- `docker-compose.oshal-local.yml` — `x-gemini-auth-volume` anchor + mount on every bot container

### 2026-04-25 — `BaseCliHarnessAdapter` extracted

The four standalone-subprocess CLI adapters (codex, claude-code, gemini,
and any future CLI harness) now share a `BaseCliHarnessAdapter` abstract
class hosting subprocess plumbing (`execCapturing`, `execWithTimeout`,
`estimateUsage`, default `healthCheck`). Reduced ~150 lines of duplicated
plumbing per adapter to ~40 lines per adapter; the next CLI harness pays
only its own domain logic.

### 2026-04-25 — `HARNESS_FACTORIES` is now type-checked

Was `Record<string, HarnessFactory>`, now `Record<HarnessType, HarnessFactory>`.
Adding a value to the `HarnessType` union without registering a factory is
now a compile-time error rather than a silent runtime fallthrough.

### 2026-04-25 — Built-in `incident` workflow dropped its `reviewerBot`

[WORKFLOW_PIPELINES.incident](../../src/features/swarm-orchestration/services/queue-manager-service.ts) used to declare
`reviewerBot: 'queue-bot'` + `maxRevisions: 2`. Now declares only `workerBot:
'rca-specialist'`. Architectural alignment with the design intent: each
ticket-type workflow is one bot whose persona embeds the quality gate
(Mode A/B/C classification, citation rules, structured artifact set,
5-section HANDOVER). No external Phase-2 review by default. Manifests
that genuinely need a separate audit pass can opt in by declaring
`reviewerBot` themselves.
