# Why OSHAL?

> A pragmatic comparison vs. LangGraph, CrewAI, and AutoGen — with code-level proof, not marketing.

The multi-agent orchestration space is crowded. Every framework claims
"agents working together." This document explains, at the code level,
what OSHAL does that the alternatives don't.

---

## The 60-second pitch

**In OSHAL, every agent in the swarm can run a different vendor's agent
runtime — routed per bot, not just per model.** A single ticket can flow
through:

- A `codex-cli` bot using OpenAI's gpt-5.3-codex
- Then to a `claude-code` bot using Anthropic's Sonnet 4.6
- Then to a `gemini-cli` bot using Google's Gemini 2.5 Pro

…coordinated through Redis streams, sharing a workspace, with cost
tracked per-bot per-call. The dispatcher doesn't know or care which
vendor is on the other side; the persona file is the contract.

The other thing that's different: **the persona IS the swarm**. We
don't run a separate "reviewer agent" by default. Each bot's persona
embeds Mode A/B/C classification, citation rules, the artifact set,
and a 5-section escalation packet. One bot, one ticket, real quality
output — at $1.30 per real database-incident RCA, vs. $4.05 for the same
work in a 2-bot review pipeline.

---

## Head-to-head

| feature | OSHAL | LangGraph | CrewAI | AutoGen |
|---|---|---|---|---|
| **Agent runtimes (harnesses)** | 4 — Cline, Codex CLI, Claude Code, Gemini CLI | 1 — its own runtime | 1 — its own runtime | 2 — own runtime + UserProxy |
| **Mix-mode swarm** (different harnesses in one ticket) | Yes — `harnessType` per bot in registry | No — single graph runtime | No — single Python runtime | No — single Python runtime |
| **Vendor-neutral provider** | Yes via OpenAI-compatible base URL on every harness | partial — through LangChain LLM abstractions | partial — via LiteLLM | partial — via OpenAI-compatible endpoints |
| **Persona-as-quality-gate** (no external reviewer needed) | Yes — Mode A/B/C + citation + 5-sec HANDOVER baked into persona | No — explicit reviewer node required | No — separate "reviewer" crew member | No — explicit reflection agent required |
| **Type-checked harness extension** | Yes — `Record<HarnessType, …>`, missing factory = TS error | n/a | n/a | n/a |
| **Working real-world incident RCA out of the box** | Yes — the `incident` ticket type ships with persona + corpus + tests | No — bring your own | No — bring your own | No — bring your own |
| **Per-call cost tracking with vendor attribution** | Yes — `chat_tasks.total_cost` keyed by `agent_id` | partial — through callbacks | No — operator builds it | No — operator builds it |
| **Live cockpit UI** | Yes — ticket workbench, RCA tab, queue dashboard | No | No | No |
| **OSS license** | MIT | MIT | MIT | CC-BY-4.0 (docs) + MIT (code) |
| **Stack** | TypeScript + Docker | Python | Python | Python |

---

## Differentiator #1 — Mix-mode harnesses with one shared workspace

**Claim:** Different agents in the same swarm run different vendor CLIs
against different LLMs and read/write the same workspace.

**Code-level proof:**

- [`HarnessType` union](../src/features/llm-provider/services/harness-adapter.ts) — six values (cline, codex-cli, claude-code, gemini-cli, a2a, noop)
- [`BaseCliHarnessAdapter`](../src/features/llm-provider/services/base-cli-harness-adapter.ts) — shared subprocess plumbing (spawn, timeout, stdout/stderr, exit code) for the three CLI-spawn harnesses
- [`HARNESS_FACTORIES`](../src/app/composition/provider-runtime.ts) — typed `Record<HarnessType, HarnessFactory>`; missing factory is a TypeScript compile-time error
- [Bot registry](../src/app/extensions/swarm/swarm-bot-registry-local.ts) — declares `harnessType` + `apiType` per bot. Today's mix:
  - `rca-specialist` → codex-cli + openai-codex
  - `research-bot` → **gemini-cli + google-gemini** (added this session)
  - `code-reviewer` → claude-code + claude-code (Anthropic direct)
  - `system-architect` → codex-cli + openai-codex
  - …14 more

**Try it:** the gemini-cli addition is the worked example — six files, ~300 lines new code, type-checked, behavior-tested. See [ADR-033](adr/033-multi-harness-execution-framework.md).

**Why nobody else has this:** LangGraph and AutoGen own the agent runtime — adding a new one means rewriting graph nodes. CrewAI is Python-only and hardcoded to its tool model. OSHAL's harness layer is an explicit interface (`HarnessAdapter`); whoever ships a new agent CLI tomorrow is one adapter file away from being a swarm participant.

---

## Differentiator #2 — Persona is the swarm

**Claim:** A single bot can produce reviewer-grade RCA output with no separate review phase, because the persona embeds the quality contract.

**Code-level proof:**

- [`rca-specialist.yaml`](../ai-lab/bot-personas/rca-specialist.yaml) — persona perspective declares:
  - Mode A/B/C output classification stamped on RCA-REPORT line 1
  - Failure-mode taxonomy table (common OOM failure modes with grep patterns + corpus refs)
  - 5-section HANDOVER (Verdict / Revisions / Summary / Escalation packet / Open items)
  - Citation rules — every claim backed by `> **Citation:**` block with `doc_id` from corpus or workspace, `web:` prefix for non-corpus
  - "Silence is not acceptable" — declare absence rather than omit
- [`WORKFLOW_PIPELINES.incident`](../src/features/swarm-orchestration/services/dispatch-routing.ts) — declares only `workerBot`, no `reviewerBot`. One bot, one ticket. (Manifests can opt in to a Phase-2 reviewer if they genuinely need it.)

**Cost data:**

| persona shape | scenario | cost | tokens | source |
|---|---|---|---|---|
| Original `rca-specialist` (median of 7 historical incident tickets) | k8s OOMKilled, NS quota, etc. | **$4.05** | ~2.0M input | `chat_tasks.total_cost` |
| Optimized RCA persona (post-iteration) | database OOM with seeded corpus | **$1.30** | 588k input (95.6% cached) | measured run |

**~68% cost reduction, ~71% fewer input tokens, structurally richer output** (4-row failure-mode taxonomy + 5-section escalation packet + Mode A/B/C marker that the original persona didn't have).

**Why we do it this way:** other frameworks can gate too — CrewAI Task Guardrails, LangGraph/AG2 review rounds — but they typically bolt on a *separate* reviewer agent. OSHAL bakes the quality gate into the persona contract: enforced output structure (Mode classification, citation blocks, failure-mode taxonomy) makes a single bot reviewer-grade. That's what the 9 prompt-iteration rounds bought — and why one bot lands the RCA at $1.30 where a multi-agent review pipeline cost $4.05.

---

## Differentiator #3 — Real working domain personas

**Claim:** OSHAL ships with a working incident root-cause analysis pipeline, not a "build your own" example.

**Code-level proof:**

- `swarm-apps/intelligent-operations.yaml` — manifest wiring the incident pipeline (`pipeline: incident-rca`, a worker persona embedding the full quality gate)
- `scripts/rag-enable-embeddings.sh` — builds the `infra-runbooks` ChromaDB collection with server-side embeddings
- Working incident-RCA runs in the prompt-iteration log with cost / token / artifact data

**What that means:** an operator can submit a ticket about a container or database OOM and get back a real RCA with corpus citations, an executable diagnose.sh / remediate.sh / rollback.sh, and a copy-paste-ready escalation packet. Today.

**Why this matters:** most frameworks are a toolkit — you build the vertical yourself. OSHAL ships with a production-shaped incident vertical, and the pattern (persona + manifest + corpus seeder) is reusable for any other vertical.

---

## What OSHAL is NOT

Honest scope:

- **Not a no-code platform.** You write YAML for personas and TypeScript for new harnesses. There's no drag-and-drop graph editor.
- **Not a hosted service.** Self-hosted via Docker Compose. We bring our own infra (Postgres, Redis, ChromaDB).
- **Not a replacement for LangChain.** It complements one — most harness adapters can sit on top of LangChain LLM abstractions. The framework is at the agent-runtime level, not the LLM-call level.
- **Still beta.** Real bugs in the working tree (see [BACKLOG.md](BACKLOG.md) for known deferred items).

---

## When NOT to use OSHAL

- You're building a single-agent product with no orchestration needs → use the underlying CLI (Cline, Codex, Claude Code, Gemini) directly.
- You need a Python-native graph DSL → use LangGraph.
- You need a Python crew abstraction with shared memory → use CrewAI.
- You need a research-y agentic chatroom for experimentation → use AutoGen.

OSHAL's sweet spot: **production multi-agent workflows where you want
vendor-neutral mix-mode swarms with persona-driven quality gates and
real cost tracking**.

---

## Roadmap (current)

See [BACKLOG.md](BACKLOG.md) for the full list with done-when criteria. Highlights:

- Wire `incident-remediation-bot` into a dedicated `incident-remediation` ticket-type workflow
- Continue `queue-manager-service.ts` decomposition (started in commit `de26008` + `8127abb`; 2 of 3 extractions remaining)
- Google Custom Search Engine wiring (operator-config gap)
- Docker Desktop port-forward wedge — upstream + auto-recovery watcher

---

## See also

- [README.md](../README.md) — quick start and architecture overview
- [CLAUDE.md](../CLAUDE.md) — architecture guide for contributors and AI tools
- [CHANGELOG.md](../CHANGELOG.md) — what's shipped, what's coming
- [docs/adr/](adr/) — architecture decisions (start with 033-multi-harness-execution-framework)
