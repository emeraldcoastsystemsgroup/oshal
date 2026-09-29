# ADR-170: Token rating, capability tiers, and moving work from the model into code

Date: 2026-09-29
Status: **Proposed; the D2 declaration and the D10 ledger are built in core** (the `rating:` block validated by the loader, all ten kernel manifests rated, `docs/apps/ai-usage-ledger.md` generated and gated in CI and `ci-local.sh`). **The store half, the P0 token generator, the P1 model-rating harness and everything else are not built. Open questions Q1-Q6 are for the operator.**
The Context records what exists at core `main` `a5826495` and store `main` `cc38f11`, measured with the
stack down (operator instruction). Every number below is either a static measurement of the tree, with the
command recorded at the end, or a labelled estimate that slice P0 replaces with generated figures. No
estimate here is to be quoted as fact.

Related: [ADR-036](036-bot-owned-application-architecture.md) (the bot owns the domain; the persona embeds
the quality gate), [ADR-038](038-swarms-bundled-by-type.md) (the closed deterministic provider-intent
boundary), [ADR-046](046-token-chase-checkpoint-replay-optimization.md) (Token Chase: per-call frames,
replay, judged savings), [ADR-090](090-skills-as-first-class-packages.md) (kernel skills reached through
`uses:`), [ADR-097](097-app-suites-primary-categorization.md) (suites), [ADR-103](103-ai-office-one-themed-engine.md)
(AI Office: one outline, code renders three artifacts), [ADR-122](122-model-is-untrusted-principal.md),
[ADR-127](127-demo-mode-cli-brain-and-user-provider-preference.md) (why the CLI harnesses are refused
unattended, and the demo-mode operator carve), [ADR-137](137-deploy-modes.md) (deploy modes, the edition seam).

Paths are core-relative unless prefixed `store/`, which means the store repository.

## Context

### The operator's request (2026-09-28)

- Push the lifting into code and services and leave the model with simple decision-making. The example:
  the model lays out a deck outline and picks from a set of themes; a codebase turns that into the deck.
- Know how many tokens each major business process of an application spends (finance, monitoring, LoRA,
  ...), so the functions that spend the most are known, and from that estimate the class of model each
  process actually needs.
- A **token rating** for applications and for models. The same product then ships in editions by rating
  and assigned model, so a person on a PC with no online account still gets some AI-generated deck
  functionality.
- An audit for coding and MCP opportunities that take work off the model.
- A roadmap, and a judgement on whether any of this makes sense.
- (2026-09-29) The rating is **per application**, and it covers what the application itself does, not
  only its tickets and chat: "create an image", "create a PDF", and the batch grinders (world
  intelligence, jobs). The example: Portrait Studio's average image creation costs some number of
  tokens and needs a model of some tier or better, and there is also a reduced edition of Portrait
  Studio on a local model with a reduced instruction set, worse graphics, but good enough that the
  LoRA character puts your head on an image. Not as good as a frontier model; on the roadmap.
- (2026-09-29, later) The point of the rating is a **label a person reads before installing**: "the
  email application is a medium token user, about so many tokens per email", so they know whether a
  minimum model or edition is required to run it in their swarm. It can start as release notes and a
  clarification of models and model features per package. The same analysis shows where new features
  can come from satellite nodes, and where codebases and local models in the core would buy speed.

### What already exists

- **The exemplar is built.** AI Office (`store/presentations`, ADR-103): `outlineFromTopic` asks the comms
  bot for a JSON outline of N slides; `renderPptx`, `renderDocx` and `renderXlsx` do the lifting through a
  shared theme catalog; the Guide mode has the model emit `set_outline | update_slide | add_slide |
  set_theme` operations that code validates and applies
  (`store/presentations/src-routes/bot-presentation-routes.ts:79-197`). The persona is 6,838 bytes. This
  is the pattern the request describes, already in production for one package.
- **Per-call accounting exists.** `chat_tasks` (migration 005) carries `total_input_tokens`,
  `total_output_tokens`, `usage_by_model` and `agent_id` per task. `CostTrackingService` aggregates
  `byAgent`, `byModel`, `byProvider` and per ticket tree
  (`src/features/operational-intelligence/services/cost-tracking-service.ts:288-491`). Budgets and a cost
  ledger arrived with migration 078 (`oshal_budgets`, `oshal_cost_events`).
- **The proof rail exists.** Token Chase (ADR-046, `src/features/token-chase/`) records per-call frames
  under `<task workspace>/.tokenchase`, replays a run, runs variant lanes, grades them against a rubric,
  and reports judged savings with a keep-winner promotion loop. Any claim that an offload saved tokens at
  equal quality is a Token Chase judged-savings report, not an assertion.
- **Manifests carry one AI flag today.** `smoke[].requiresAi` is validated by the loader
  (`src/features/swarm-apps/services/swarm-app-loader.ts:363`) and gates the installed test catalog
  (`installed-app-test-catalog.ts:86,127,140`). There is no per-feature tier, context floor or degrade
  declaration.
- **The edition seams exist.** Deploy modes (ADR-137) and the `noop` provider (`FORCE_LLM_PROVIDER=noop`,
  the zero-keys demo) already split the product by what inference is available.
- **The Cline route to open models is wired, and it is refused unattended because of the tool loop, not
  the model.** The `ollama` and `lmstudio` provider ids carry a `clineProvider`
  (`any-bot/server/services/llm/registry/provider-definitions.js:193,515`); the registry writes that id
  into Cline's `actModeApiProvider` and `planModeApiProvider` (`registry/global-state-builder.js:54-55`);
  the bot node constructs a `ClineProvider` at startup (`app-modules/startup-core-services.js:85`) and the
  compose `local-llm` profile ships an Ollama container behind `OLLAMA_HOST`. Every Cline spawn point
  then calls `assertCliToolBoundary(options, 'cline-cli')` (`services/codebase/ClineCLIWrapper.js:318-741`),
  which throws `UNENFORCEABLE_CLI_TOOL_BOUNDARY` unless `DEMO_MODE` is on and the launching user is in
  `OSHAL_OPERATOR_SUBS` (`services/llm/assert-cli-tool-boundary.js`, the ADR-127 carve). The check keys on
  the harness name, so an open model behind Cline is refused exactly as a hosted one is. ADR-127 records
  the reason: a CLI harness owns its own tool loop, can read its credential home, and cannot revalidate
  oshal's handler generation or operation scopes mid-loop. So today an open model through Cline runs for
  the deployment operator in demo mode and for nobody unattended.
- **Cline is the widest provider surface in the codebase, and the operator's point that "all models are
  covered" through it is correct.** Cline's README ("Works With Every Model") lists Anthropic, OpenAI,
  Google, OpenRouter with 200+ models, Vercel AI Gateway, Bedrock, Azure and Vertex, Cerebras and Groq,
  Ollama and LM Studio, and any OpenAI-compatible API. In this tree the Cline-facing registry
  (`any-bot/server/services/llm/registry/provider-definitions.js`) declares 21 provider ids with 24
  `clineProvider` mappings, and the TS catalog (`src/features/llm-provider/services/provider-definitions.ts`)
  declares 40 (counts from the commands at the end of this ADR). The cockpit's LLM Settings page
  (`src/pages/chat/ui/chat-config-api-runtime.mjs`, fields from `src/api/ui-provider-fields.js`) is that
  surface: saving a provider and model writes Cline's `globalState.json` through `buildGlobalState`
  (`any-bot/server/app-modules/routes-llm-settings-stream.js:190-199`). D8 by contrast covers one shape,
  the OpenAI-compatible HTTP API, which is what Ollama, LM Studio, vLLM and llama.cpp expose but not what
  Bedrock, Vertex or Anthropic-native expose. Coverage and permission are separate questions: Cline
  reaches every model and is refused unattended; D8 reaches a subset and would run unattended.
- **The non-CLI route keeps oshal's own tool loop, and exists only as a caller's BYO connection.** An
  OpenAI-compatible provider with a base URL (`any-bot/server/controllers/TaskController.js:1229`) is built
  per request from `byoLlmConnection`, and it runs tool-less by the operator's 2026-09-22 decision
  (`TaskController.js:348-354`), because a caller's endpoint must not drive the bot's tools.
  `OpenAIProvider` already honours a configurable base URL (`any-bot/server/services/llm/OpenAIProvider.js:59-67`)
  and runs `runDeclaredToolExchange` server-side, which is the boundary Cline cannot enforce.
- **What the dev box's traces show.** `workspace/task-*/agent-context.md` files are 21-byte stubs and
  `workspace/provider-ticket-1/shopping-concierge-context.md` is 3.5 KB. Live `chat_tasks` rows were not
  read (stack down). The measurement below is therefore static, and P0 exists to replace it.

### Static measurement: where the prompt tokens are

Method: persona file bytes divided by four approximates the system-prompt tokens every call to that bot
pays before any input or output. Route-level model-call sites are a grep for
`executeBotOrInline | BotNodeClient | inline-bot | swarm-execute` over a package's `routes/` and
`src-routes/`. The grep is crude: it undercounts packages whose bots are driven by tickets and workflows
rather than routes, and a package with zero personas may still run on a core bot through its routing
declarations. Commands are recorded under "Measurement commands".

Core personas (`ai-lab/bot-personas`, core `a5826495`):

| Persona | Bytes | System tokens per call, approx. | Where it is paid |
|---|---|---|---|
| codex-packer | 20,893 | 5.2k | every turn of a packing interview |
| oshal-assistant | 19,887 | 5.0k | every Jarvis / chat turn |
| rca-specialist | 17,723 | 4.4k | every incident worker call |
| workflow-assistant | 10,350 | 2.6k | workflow-build |
| system-architect | 7,155 | 1.8k | build ticket worker |
| security-analyst | 4,424 | 1.1k | security-finding |
| queue-bot | 2,795 | 0.7k | reviewer pass |

Store packages (store `cc38f11`), the heaviest by persona bytes and call sites, plus the domains the
operator named:

| Package | Personas | Persona bytes | Route files | Route-level model-call sites | Reading |
|---|---|---|---|---|---|
| venture-plan | 4 | 39,500 | 70 | 44 | long-document generator; the heaviest system prompt in the store |
| little-monsters | 6 | 35,575 | 80 | 232 | tutoring dialog; the most model-call sites by a wide margin |
| marketing-engine | 4 | 17,274 | 25 | 27 | campaign drafting |
| video | 3 | 16,935 | 34 | 20 | script and shot planning |
| pumpkin | 1 | 13,303 | 22 | 28 | persona-heavy assistant |
| trading | 4 | 11,195 | 52 | 57 | sleeve maths is code (ADR-052/168); model writes rationale and recap |
| switchboard | 1 | 7,052 | 29 | 59 | phone dialog per call |
| email-summarizer | 1 | 7,052 | 12 | 39 | digest over normalised threads |
| presentations | 1 | 6,838 | 8 | 12 | the exemplar: outline in, rendered artifact out |
| embodied | 1 | 6,762 | 113 | 34 | mostly code; model plans |
| career-hunter | 1 | 6,551 | 84 | 38 | resume review, story per role |
| lora | 1 | 4,079 | 22 | 0 | training, validation and scoring are code; the persona explains scorecards |
| daily-trade-recap | 1 | 4,424 | 8 | 0 | recap narrative |
| finance | 0 | 0 | 10 | 29 | runs on core or routed bots |
| payroll | 0 | 0 | 46 | 33 | runs on core or routed bots |
| kalshi | 0 | 0 | 16 | 9 | runs on core or routed bots |
| home | 1 | 7,650 | 6 | 22 | intent to device action |
| system, sat-ops | 0 | 0 | 2, 6 | 0 | monitoring surfaces; model-free at the route level |

Two readings follow directly. First, for the chat-shaped bots the system prompt is the dominant cost per
call: a Jarvis turn that produces 300 output tokens pays about 5,000 tokens of persona to get there.
Second, most of the persona bytes in the heavy files are format and validation instructions (artifact
layout, citation rules, mode classification, what to check before answering), which is exactly the class
of work code can enforce.

### Capability tiers

The request needs a vocabulary for "what must the model actually do". Five tiers, by the shape of the
decision, not by the domain:

| Tier | The model's job | Context | Output | Model class that passes | Local hardware that runs it |
|---|---|---|---|---|---|
| T0 | none; deterministic code | n/a | n/a | none | any |
| T1 | pick from an enumerated set, route, rank, yes/no | up to 4k | up to 300 tokens, JSON | 1B to 4B, or rules and embeddings | any CPU |
| T2 | produce a bounded JSON plan for code to render or apply | up to 16k | 0.5k to 2k, schema-constrained | 20B to 30B mixture-of-experts (gpt-oss-20b, Qwen3-30B-A3B) | one 24 GB GPU, or CPU with 32 GB RAM |
| T3 | grounded reasoning with citations over retrieved context | 16k to 64k | 1k to 4k | 120B-class MoE (gpt-oss-120b) or a hosted model | one 96 GB GPU |
| T4 | long-horizon tool loops, code generation, multi-turn authoring | 64k to 128k and beyond | many turns | frontier hosted (gpt-5.5, Claude) | not local today |

The model-class column is a starting hypothesis for slice P1 to test, not a result.

### Per-process token profile (estimates; slice P0 replaces every row)

Built from the measured persona sizes plus assumed input and output sizes. "Calls" is calls per one
business transaction. The tier column is the judgement this ADR proposes for each process.

| Business process | Where | Tier today | Tier it needs | Sys tokens (measured) | Est. tokens per transaction | Notes |
|---|---|---|---|---|---|---|
| Incident RCA | core `intelligent-operations` | T3 | T3 | 4.4k worker + 0.7k reviewer | 12k, up to 40k with two revisions | RAG top-5 in, artifact set out; artifact skeletons are offloadable |
| Build ticket | core `oshal-engineering` | T4 | T4 | 1.8k | 50k to 300k | tool loop; stays frontier |
| Security finding | core `security` | T3 | T3 | 1.1k | 6k to 12k | |
| Workflow build | core `workflow-studio` | T2/T3 | T2 | 2.6k | 6k to 20k | graph is code; model drafts nodes |
| Jarvis / assistant turn | core `jarvis` | T2 | T2 | 5.0k | 6k to 9k per turn | about 70% is persona; first offload target |
| Packing interview | core `codex-packer` | T4 | T3 | 5.2k | 60k to 150k | multi-turn |
| Deck / doc / workbook draft | store `presentations` | T2 | T2 | 1.7k | about 3k; Guide edit about 2.5k per turn | already the target shape |
| Tutoring turn | store `little-monsters` | T3 | T3 with T1 sequencing | 1.5k avg persona | 5k to 9k per turn; 100k+ per learner-hour | mastery tracking, spaced repetition and closed-form grading are code |
| Trade rationale / daily recap | store `trading`, `daily-trade-recap` | T2 | T0 template + T2 summary | 0.7k to 1.1k | 3k to 5k per recap | per-trade rationale should be templated from structured signals |
| Email digest | store `email-summarizer` | T3 | T3 with T1 ranking | 1.8k | 6k to 11k | thread dedupe, sender ranking, date and amount extraction are code |
| Resume vs posting review | store `career-hunter` | T3 | T3 with T1 scoring | 1.6k | 10k to 25k | job scoring by embedding similarity is code |
| Venture plan | store `venture-plan` | T3 | T2 outline + T3 sections | 2.5k avg | 40k to 120k | AI Office pattern: outline, then render |
| LoRA training round | store `lora` | T0 run, T2 explain | same | 1.0k | 0 for the run; about 3k to explain a scorecard | already correctly split |
| Home intent to device action | store `home` | T2 | T1 | 1.9k | about 2k | closed command allowlist already exists (ADR-169 pattern) |
| Alert triage | core `alert-triage` | T1/T3 | T1, escalate to T3 on novel | n/a | 2k per alert if the model is in the loop | auto-apply already decides in code |

### Application and batch mechanisms (measured 2026-09-29)

The table above ranks ticket- and chat-shaped work. This section answers the operator's second
question: what the applications themselves do, especially generation and the batch processes, and by
which mechanism: deterministic code, an external or local generation service, a provider intent, or a
model call. Method: every `schedules:` block in the store manifests and the schedule kinds the core
runtime dispatches (`src/app/schedule-runtime.ts` dispatches 14 kinds: assess, futures-research, home,
lab, manifest-service-route, optimize, research, review, schwab-futures-capture, swing, trading-event,
trading, workflow-ticket, world); the dispatcher or handler of each grepped for model-call sites and
ticket creation; generation backends by exact API and product strings. An earlier pass in this thread
matched the English word "stability" in six packages and reported hosted image APIs that do not exist;
only exact strings count and the commands are recorded at the end.

**Batch and scheduled processes.** Model per run is what the dispatcher or handler itself does; a
schedule that files a ticket a bot then works is marked as such.

| Process | Cadence | Mechanism | Model per run | Tier |
|---|---|---|---|---|
| World ticker pulse | every 5 min, 08-23 Mon-Fri (192 pulses a day) | feed pull, content-hash dedupe, classifier on new items only, lexicon fallback | Haiku (`WORLD_SENTIMENT_MODEL`), 10 items per call, budget 60 calls an hour and 400 a day, then lexicon | T1 with a T0 fallback |
| World refresh | every 6 h | same engine, depth fan-out over topics, macro and the stock universe | same budget | T1 |
| Trading autopilot tick | every 5 min by default | sleeve maths and orders in code; files a `trading-decision` ticket already `complete` (a record) | 0 | T0 |
| Trading assess, research, review, swing | schedule-driven | code; record ticket | 0 | T0 |
| Trading optimize | 05:30 daily | code; record ticket | 0 | T0 |
| Futures research | 02:00 daily | code; record ticket | 0 | T0 |
| Trading event plans | every minute, 07-19 Mon-Fri | code | 0 | T0 |
| Schwab futures capture | hourly | code | 0 | T0 |
| Trading lab | 21:45 Mon-Fri | simulation | 0 | T0 |
| Kalshi scan | configured interval | code scan; model only on user-triggered analysis | 0 | T0 |
| Calendar meeting briefs | every 15 min | code assembles a cited brief from recorded material | 0 | T0 |
| Daily trade recap | every 15 min | code reconciles up to 50 journal entries into briefings | 0 | T0 |
| Venture-plan rebaseline tick | hourly | code | 0 | T0 |
| Marketing daily ingest | 06:20 daily | code reads Search Console, PostHog, GitHub traffic | 0 | T0 |
| Marketing weekly review | Mon 12:00 | code rollup; one ticket per owner; a bot runs only after a human approves it | 0 per run, T3 per approved ticket | T0, then T3 |
| LoRA overnight | 02:00 daily | kohya training and ComfyUI generation and validation on the operator's GPU box | 0 LLM | T0, local image model |
| Social daily digest | 13:00 daily, per user with Facebook connected | the communications bot with a prompt over the day's signals | 1 per user | T3 |
| Home solar schedules | sunrise and sunset, per user | home bot intent, then a device action | 1 per firing | T1 to T2 |
| Workflow-ticket schedules | per registered schedule (runtime data) | files a `workflow:<ticketType>` ticket a bot works | 1 ticket per fire | T3 to T4 |

Three readings. The world classifier is the one batch process with a real model in the loop every
run, and it is already the shape this ADR wants: a T1 job with a budget object and a free T0 fallback,
so moving it to a local small model or an embedding classifier removes hosted spend without a
behaviour change. The trading family, the largest set of schedules, is code end to end; its 57
route-level model-call sites are user-triggered research and assessment, not the tick. The
unbounded ones are per-user or per-registration: the social digest scales with connected users,
workflow-ticket schedules with whatever the operator registers.

**Generation and media backends.** What "create an image" or "create a PDF" runs on today.

| Capability | Where | Backend | LLM in the loop |
|---|---|---|---|
| Image generation | store `lora`; core `video-generation` | ComfyUI on the operator's GPU box over the LAN; kohya for training | none; the `lora-director` persona explains scorecards on request (T2) |
| Video generation | core `video-generation` | DeckToVideo (code, free), ComfyUI (free), Veo (paid escalation behind approval) | one file drafts a prompt |
| Portrait compositing | store `portrait-studio` | `sharp` layers over 225 presets; no external host, no model call anywhere in the package | none |
| Office documents | presentations, venture-plan, little-monsters, career-hunter | pptxgenjs, docx, exceljs renderers | T2 outline only |
| PDF | nowhere | no PDF library in any store route or in core `src` | not built |
| Speech | core `voice-providers` (pluggable harness); browser speech in surfaces | TTS provider, not model tokens | none |
| 3D reconstruction | core `spatial-mapping` | `RECON_URL` edge service | none |
| Media processing | circuit-lab, create, payroll, pumpkin, scan-to-print, video | ffmpeg, sharp, canvas | none |
| MCP | core `mcp.call-tool` provider intent (browser task, explicit remote ticket, mesh task, series dispatch); store `lora`, `vids`; `remote-client` stdio client | deterministic intent inside the ADR-038 boundary | none; D7 is partly built |

No hosted image API is wired anywhere in the tree. Image generation is local ComfyUI, and the only
paid generation escalation is Veo for video. Portrait Studio today is entirely code, which makes it
the reduced edition already; the full edition is what does not exist yet.

## Decision (proposed)

**D1. The tiers are the vocabulary.** Every model-touching feature declares one of T1 to T4. T0 needs no
declaration; it is the default for a route that never calls a bot.

**D2. A feature's token rating is declared in the manifest and measured by the platform.** A manifest
gains a `rating:` block, which also carries the container memory the application needs (operator,
2026-09-29: "container memory size required per application, low and high"):

```yaml
rating:
  memoryMb: { low: 64, high: 256, basis: declared }   # MiB; basis declared | observed
  features:
    - id: deck-outline
      unit: deck                 # the thing one transaction is
      tier: T2                   # T1 | T2 | T3 | T4 (T0 is code and never declared)
      generation: none           # none | local | hosted (D9)
      degrade: template          # template | hosted | disable | reduced
      contextFloor: 8192         # optional, tokens
    - id: guide-edit
      unit: guide edit
      tier: T2
      generation: none
      degrade: reduced
      reducedEdition: set_theme and update_slide only, on a local 20B-class model
```

`features: []` is a declaration that the package has no model in the loop. The declared fields are
`memoryMb`, and per feature `id`, `unit`, `tier`, `generation`, `degrade`, `contextFloor` and
`reducedEdition` (required when `degrade: reduced`). The measured fields (`tokensPerTransaction` p50
and p95, `callsPerTransaction`, `outputTokens` p50, `modelsVerified`) are generated by P0 and P1 from
`chat_tasks`, Token Chase frames and Test Lab runs, never hand-typed into the manifest (anti-drift rule 2
in `CLAUDE.md`); the loader refuses them as unknown fields. The loader validates the declared block the
way it validates `suite:` (`src/features/swarm-apps/services/swarm-app-rating.ts`): a malformed value
fails the load, a missing block warns. Each repository keeps a generated ledger of every manifest's
block (`scripts/ai-usage-ledger.js`; core `docs/apps/ai-usage-ledger.md`), and a `--check` gate fails on a
stale ledger or an unrated manifest.

**D3. A model's rating is a generated record, not a claim.** The AI Test Lab runs a package's registered
scenarios against a named model and records `{ model, tierPassed, contextWindow, costClass, tokPerSec }`,
where `costClass` is one of `local-free | metered | frontier`. A tier is "passed" only when every scenario
at that tier passes the rubric.

**D4. Matching and degrade.** A feature runs on the active model only when `tierPassed >= tier` and
`contextWindow >= contextFloor`. Otherwise the declared `degrade` applies: `template` runs the feature's
T0 path (AI Office renders a starter outline without a model), `hosted` routes the call to the hosted rail
only when the caller has one, `disable` returns a clear message. The default is `disable`. A local edition
never silently falls through to a paid rail.

**D5. Editions map onto ADR-137 deploy modes.** Local (T0 to T2 on a local model, no account), Connected
(adds T3 through hosted or BYO), Pro (adds T4). One package, one manifest; the loader gates features by
D4. The "deck on a PC with no account" case is Local edition running `presentations` at T2 on a 20B-class
model.

**D6. Offload doctrine.** A persona states identity and judgement. Format, validation, arithmetic,
ranking, retrieval, rendering and step orchestration are code. The audit looks for six shapes:

1. Boilerplate the model regenerates every call (artifact skeletons such as `HANDOVER.md`, citation block
   layout, JSON envelope framing). Move to templates and post-processors.
2. Rules the persona asks the model to check ("ensure", "verify", "never"). Move to schema-constrained
   output and code validators, then delete the instruction from the persona.
3. Classification hiding inside a T3 bot (ticket type, priority, intent, mode A/B/C). Move to a T1 call or
   to rules and embeddings.
4. Ranking and retrieval done in prose (job fit, email priority, news relevance). Move to code; the model
   sees the top-k, not the pile.
5. Narratives assembled from structured data (trade rationale, recap, standup summary). Template first;
   the model writes only the free-text paragraph.
6. Orchestration written as prompt steps. Move to a process-definition graph (Workflow Studio publish)
   with the model at branch nodes only.

**D7. MCP stays inside the ADR-038 boundary.** Two directions, one rule. Outward, deterministic provider
intents are exposed as MCP tools so any rated model does one schema-bounded call instead of reasoning
over raw payloads. Inward, external MCP servers (calendar, files, source control) are consumed
server-side as deterministic intents whose normalised results reach the model. Credentials never become
model-visible; MCP is not a model tool environment. The remote-client bridge (`src/features/remote-client/`)
is the existing seam.

**D8. The one core change, gated on approval.** P3 needs an operator-configured OpenAI-compatible
provider, with a base URL, that a bot can carry as its default and that runs oshal's own tool loop. The
question D8 answers is whose tool loop runs, not which model: Cline runs its own loop and cannot enforce
the closed provider-intent boundary (ADR-127), so an open model through Cline stays a demo-mode operator
tool; the same open model behind Ollama's, LM Studio's or vLLM's HTTP API driven by `OpenAIProvider`
keeps the tools server-side. The 2026-09-22 tool-less decision concerned a caller's endpoint driving the
bot's tools; D8 is the operator's endpoint as the bot's brain, the same trust posture `openai-codex`
holds today. The alternative is the audited brokered sandbox CLAUDE.md names as the condition for
re-enabling a local CLI, which is the larger job. This is core (Rule 0d) and is not started until the
operator answers Q5.

### Per-application rating, worked examples (D9)

**D9. An application's rating is per feature and has two axes, and every rated feature may declare a
reduced edition.** The two axes are the LLM tier (D1) and the generation backend class: `none`,
`local` (ComfyUI, kohya, the TTS harness, the edge reconstruction service) or `hosted` (Veo today; any
hosted image API is not wired). D2's `rating.features[]` carries `generation:` and a fourth `degrade` value,
`reduced`: the same feature on a local model with a declared smaller instruction set, fewer presets,
fewer operations, fixed styles, rather than the feature disappearing. Token numbers stay generated
(P0), so "average image creation takes N tokens" is a measured field on the rating, never a typed one.

| Application | Feature | Full edition | Reduced edition (local model, no account) | Today |
|---|---|---|---|---|
| Portrait Studio | portrait from a photo | T2 model plans scene, preset and placement from the request; a hosted or local image model renders with the user's LoRA character; T3 art direction on request | preset chosen by menu or a T1 local model; `sharp` compositing; the LoRA character's face through local ComfyUI; fewer presets and styles | T0: 225 presets and `sharp`, no model at all |
| LoRA Studio | train and validate a character | T2 director explains scorecards; ComfyUI and kohya local; paid escalation gated | identical; training already runs on the GPU box | built as the reduced edition |
| AI Office | deck, document, workbook | T2 outline and Guide edits on a hosted model | T2 outline on a 20B-class local model; the starter catalog is the T0 fallback | outline on the hosted comms bot |
| Little Monsters | tutoring turn | T3 hosted per turn | T2 local explanations; mastery tracking, sequencing and closed-form grading in code; a smaller activity set | T3 hosted |
| World intelligence | headline classification | Haiku at T1 inside the 400-a-day budget | a 1B to 4B local classifier or an embedding model; lexicon fallback unchanged | Haiku, budgeted |
| Social | daily digest | T3 hosted per user | T2 local summary over signals ranked in code | T3 hosted |
| Video | generate | Veo, paid, approval-gated | ComfyUI local, DeckToVideo | both exist |

The pattern the table shows: where generation is already local and the model's job is planning or
explaining, the reduced edition is a small change; where the model does the whole job per turn
(tutoring, digests), the reduced edition is the offload work of D6 first and a smaller model second.

### The label (D10)

**D10. The rating is a label on the store listing, and it ships as text before it ships as a
schema.** A listing today carries `name, suite, displayName, description, version, theme, dependencies,
source, audit, status` (`store/marketplace.json`, consumed by `src/app/routes/app-registry-routes.ts`,
`app-store-remote.ts` and `src/features/app-registries/services/registry-host-adapters.ts`). The label
adds one block a person can read the way they read an energy rating:

| Field | Meaning | Source |
|---|---|---|
| `usage` | low, medium or high token use for the package as a whole | derived from the measured numbers, by fixed thresholds recorded with the generator |
| `unit` | the thing one transaction is: an email, a deck, a tutoring turn, a portrait | declared per feature |
| `tokensPerUnit` | p50 and p95 tokens per unit | generated by P0, never typed |
| `minimumTier` | the lowest tier (D1) at which the package's Test Lab scenarios pass | generated by P1's model-rating harness |
| `reducedEdition` | whether a `reduced` degrade (D9) exists and what it drops | declared |
| `modelsVerified` | the models and versions the harness has recorded a pass for | generated |
| `generation` | none, local or hosted, per D9 | declared |

Two rules. First, a number on the label is a generated number; until P0 has produced it the label
shows the unit, the tier the maintainer believes is required and the words "not yet measured", never
an estimate typed to look measured. Second, the label is the same data the loader gates on (D4), so a
listing can never claim an edition the running deployment would refuse.

Until the schema exists, every package's release notes carry a "Models and model features" section
in the same shape: unit, believed minimum tier, whether a reduced edition exists, which models the
package has been exercised on. That text is the label's first form, and P0 replaces its numbers.

The worked example, from the measured persona size and the estimate table above, labelled as an
estimate: Intelligent Communication (`email-summarizer`), unit = one daily digest; estimated 6k to
11k tokens per digest, which is a few hundred tokens per email at a typical inbox; believed minimum
tier T3 for the digest, T1 for ranking once ranking moves to code; reduced edition possible at T2 over
code-ranked signals; generation none; models verified: none recorded yet.

## Cost and benefit per option

| Option | What you gain | What you give up | Cost to build | Cost to reverse |
|---|---|---|---|---|
| A. Do nothing; frontier hosted for everything | best quality now; zero engineering | spend scales with usage; no offline edition; exposed to GPU and API pricing | none | none |
| B. Measure and offload only (P0 to P2) | generated per-feature token profile; smaller personas; faster and cheaper calls on every rail; the rating schema designed so C is additive | no offline edition yet | three store-and-core lanes, docs-and-script heavy, one persona rewrite wave | low: Token Chase keep-winner has a revert; templates are additive |
| C. Full rating and Local edition (P0 to P4) | a product that runs on a PC without an account; hardware-independent story; MCP as the integration shape | model qualification per release; quality ceiling at T2 locally; one core change (D8) | B plus the model-rating harness, the loader gate, D8, and one MCP connector | medium: the loader gate and D8 are core |

Recommendation: **B now.** The rails it needs already exist (Token Chase, `CostTrackingService`,
`requiresAi`, AI Office), so the marginal work is mapping and a handful of offloads, and it pays on every
rail regardless of hardware. **C is a product decision, not an engineering one.** Design P1 so C is
additive, and decide C after P1 has recorded what a 20B-class local model actually passes.

## Open questions for the operator

- **Q1. Editions.** Is a no-account Local edition a product goal (yes means P3 and D8), or is the goal
  cost and speed on the hosted rail (B only)?
- **Q2. Reference local models.** Which model does P1 qualify against for T1/T2, and which for T3?
  Proposal: gpt-oss-20b and gpt-oss-120b, both Apache-2.0 with native tool calling and 128k context.
- **Q3. Where the rating lives.** Declared `rating.features[]` in the store manifest plus a generated sidecar
  (proposal), or fully generated with no declaration?
- **Q4. Degrade default.** `disable` with a message (proposal), `template` where one exists, or `hosted`
  when an account is present?
- **Q5. Which route carries the fleet to open models.** Two options, both real:
  (a) **D8**, an operator-configured OpenAI-compatible provider as a bot's default running oshal's tool
  loop; small, core, covers the OpenAI-compatible shape only, and does not wait on anything.
  (b) **The audited brokered sandbox**, which is not hypothetical: it is ADR-040 step 1, the
  "Multi-user ephemeral privileged runtime" entry in `docs/BACKLOG.md` (line 754 at core `3a31aa67`),
  greenlit as operator decision 19 on 2026-09-21 and sequenced after "Production Vault hardening"
  (decision 17) and the Postgres-engine issue/use/revoke proof (decision 18), with a written threat
  model and an adversarial review as its security gate. Once it lands, the Cline route runs unattended
  with Cline's full provider coverage and no new provider code in oshal. Choosing (b) means P3 waits
  on that chain; choosing (a) does not. They are not exclusive: (a) can carry the Local edition until
  (b) lands, after which a bot's harness is a per-bot choice.
- **Q6. Persona doctrine.** ADR-036 says the persona embeds the full quality gate. D6 narrows that to
  identity and judgement and moves the gate into code. Confirm this is wanted before the P2 persona
  rewrite of `oshal-assistant` and `rca-specialist`.

## Rollout

Each slice is accepted on its own. A slice is done only when its done-when holds; nothing here is done
today.

**P0. Measure.** A script (`scripts/ai-token-profile.js`) reads `chat_tasks` and `.tokenchase` frames,
maps `agent_id` to manifest to feature, and emits the generated per-feature profile (tier as declared or
`unrated`, p50/p95 tokens per transaction, calls per transaction, output p50). Done when: every active
package feature and every core ticket type has a generated row from at least seven days of stack uptime,
the report carries the core and store SHAs it was generated against, and no number in it was typed by
hand. The estimates table in this ADR is then replaced by a pointer to the generator.

**P1. Rating schema and the model-rating harness.** Loader validation for `rating.features[]` (built for core, see Status); a Test Lab
runner option that names the model under test and records the D3 record. Done when: `presentations`,
`trading` and `little-monsters` declare ratings, the loader refuses an unknown tier, and the harness has
recorded pass or fail per tier for the Q2 reference models with the runs attached. The D10 label is
part of this slice: those three packages' listings render it, and every other package's release notes
carry the "Models and model features" section, with "not yet measured" wherever P0 has not run.

**P2. Offload wave 1.** `oshal-assistant` and `rca-specialist` personas rewritten to identity and
judgement with format and validation moved to schema-constrained output and templates; alert triage
classified at T1 with escalation; trade rationale templated from structured signals; email ranking in
code. Done when: for each, a Token Chase judged-savings report shows fewer tokens per transaction at an
equal or better rubric grade, and the keep-winner promotion is recorded. A target of 30% fewer tokens is
the bar to aim at; the report decides.

**P3. Local edition.** A deploy mode that pins a local endpoint as fleet default (D8), the D4 gate in the
loader, and the `template` degrade path for `presentations`. Done when: a PC with no online account
produces a themed deck end to end through the local model, exercised by a human from `localhost` (the
human testability gate), and a T3 feature on the same box shows the disable message rather than a
hosted call.

**P4. MCP inside the boundary.** One external MCP source consumed as a deterministic intent, and the
existing provider intents exposed as MCP tools. Done when: authorization tests prove the credential never
reaches the model, one feature is fed by the MCP source, and the intent-as-tool path is exercised by a
rated local model at T2.

## Consequences

- **Positive.** Token spend becomes a generated, per-feature number that a manifest declares against and
  a Test Lab run verifies. Personas shrink to what only a model can do. The same package runs on a laptop
  model or a frontier model with the difference declared, not discovered.
- **Negative.** Persona compression can lower quality in ways a rubric misses; the Token Chase judged
  grade is the gate, and the keep-winner revert is the safety net. Ratings drift if anyone hand-types a
  number; D2 forbids it and P0 is the only writer.
- **Doctrine.** D6 narrows ADR-036's "the persona embeds the full quality gate" to "the persona embeds
  the judgement; code embeds the gate". That is a deliberate change and is why Q6 exists.
- **Boundary.** D7 keeps MCP on the deterministic side of ADR-038. A proposal to hand a model an MCP tool
  environment directly is out of scope for this ADR and would need its own.

## Measurement commands

Run against core `a5826495` and store `cc38f11` on 2026-09-29.

```bash
# core persona bytes
for f in ai-lab/bot-personas/*.yaml; do printf "%8d %s\n" "$(wc -c < "$f")" "$(basename "$f")"; done | sort -rn

# store inventory: personas, persona bytes, route files, route-level model-call sites
cd ../oshal-applications
for d in */; do d=${d%/}; [ -f "$d/oshal-app.yaml" ] || continue
  p=$(ls "$d"/personas/*.yaml 2>/dev/null | wc -l)
  pb=$(cat "$d"/personas/*.yaml 2>/dev/null | wc -c)
  r=$(find "$d/routes" "$d/src-routes" -name "*.js" -o -name "*.ts" 2>/dev/null | wc -l)
  h=$(grep -rhoi "swarm-execute\|BotNodeClient\|executeBotOrInline\|inline-bot" "$d/routes" "$d/src-routes" 2>/dev/null | wc -l)
  printf "%-22s %5s %8s %6s %6s\n" "$d" "$p" "$pb" "$r" "$h"
done | sort -k3 -rn

# provider coverage (core, 2026-09-29 at 3a31aa67): Cline-facing registry ids, clineProvider mappings, TS catalog ids
f=any-bot/server/services/llm/registry/provider-definitions.js
grep -c "^  [a-z0-9-]*: {" $f; grep -c "clineProvider:" $f
grep -c "^    id: '" src/features/llm-provider/services/provider-definitions.ts

# batch processes (store): schedule blocks per package; then each schedule's handler for model-call sites
cd ../oshal-applications
for d in */; do d=${d%/}; [ -f "$d/oshal-app.yaml" ] || continue
  grep -E "^\s*cron:" "$d/oshal-app.yaml" | sed "s|^|$d |"; done
# core schedule kinds and each dispatcher's model-call and ticket sites
grep -oE "is[A-Z][A-Za-z]+Schedule\(" src/app/schedule-runtime.ts | sort -u
for f in src/app/*-dispatch.ts; do printf "%s model:%s ticket:%s\n" "$f" \
  "$(grep -c 'executeBotOrInline\|BotNodeClient\|inline-bot' $f)" "$(grep -c 'createTicket' $f)"; done
# world classifier defaults
grep -nE "CLASSIFIER_MODEL\s*=|CLASSIFY_CHUNK\s*=|BUDGET_PER_HOUR|BUDGET_PER_DAY" src/features/world-data/news-fetcher.ts
# generation backends, exact strings only (the word "stability" alone is a false positive)
grep -rliE "stability\.ai|api\.stability|stable-diffusion|sdxl|replicate\.(com|run)|comfyui|COMFY|images/generations|gpt-image" \
  --include=*.ts ../oshal-applications/*/src-routes src
grep -rliE "pdfkit|pdf-lib|puppeteer|jspdf" --include=*.ts --include=*.js ../oshal-applications/*/routes ../oshal-applications/*/src-routes src
grep -cE "^\s+id: '" ../oshal-applications/portrait-studio/src-routes/portrait-presets.ts
```
