# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## RULE 0 — THIS repo is the trunk: branch → PR → merge (READ FIRST)

**CURRENT PHASE: POST-CUTOVER (2026-07-23). This repository is the development trunk.** The private
full-history repo is now a reference archive — do not commit there. See
[ADR-115](docs/adr/115-clean-trunk-branch-strategy.md).

**This repo is public-track. There is no sanitizer between your commit and the world** — the
`publish-gate.sh` pre-push hook is the wall, and it is fail-closed. Never bypass it, and never
"fix" a hit by narrowing a pattern to the file that tripped it. Gate on the identifier, not on
where it has appeared.

The rule, for every agent and human:

- **Work on a branch, land it through a PR.** `git switch -c <short-topic>` → commit → push →
  open a PR → merge. Do NOT commit directly to `main`. Do NOT create new git worktrees (one
  worktree, one index — see [Rule 0a](#rule-0a--the-shared-index-is-a-constraint-not-a-complaint-operator-2026-07-17)).
- **ONE active development branch per repo at a time** (operator, 2026-07-23). Before branching,
  `git fetch origin && git branch -r` + check open PRs — if a development branch is open, JOIN it
  instead of minting a second. The branching contract lives in
  [CONTRIBUTING.md](CONTRIBUTING.md#branching-model--the-coordination-contract-read-first);
  coordinate there. This codebase was archived four times in two years — the discipline is what
  prevents a fifth.
- **Pull before you start** (`git pull --rebase` on `main`, then branch) and **commit small +
  often** — after every working, type-checking change, not at the end of a big batch.
- **Check in on `COLLABORATE.md` before you start, and post there.** It is the ONE shared thread
  where every bot identifies itself, claims the files/areas it's working on, announces deploys, and
  asks/answers questions to other bots. Read the recent entries (respect open claims), post your
  claim when you begin, answer anything addressed to you, and post a release when done.
  **It is deliberately UNTRACKED here** (gitignored — it is internal coordination and the publish
  gate refuses it), so it is local to this working directory and does not merge through git.
  Append self-contained entries at the END only.
- **Push your branch immediately after committing** so other agents can see your work. Work that
  lives only in your tree is invisible to everyone else and is the root of the confusion.
- **Merge your own PR when it is green** — the PR is for the publish gate and a diff you can read,
  not for waiting on someone. A long-lived branch is the branch sprawl this project already paid
  for once; land it the same day. (This is the MAINTAINER rule — swarm agents act under the
  operator's maintainer account. `main` is branch-protected: external contributors' PRs require a
  maintainer's approval, direct pushes are rejected, and auto-merge is disabled — see
  CONTRIBUTING.md "Who can do what".)
- **Never `git checkout`/`switch`/`reset` away from another agent's in-progress work**, and never
  force-move or `reset --hard` a shared branch. If `main` won't fast-forward, `git pull --rebase`
  and resolve — do not force.
- Deployment follows `main` via the hot-swap override (`docker-compose.hotswap.yml`, tsx-watch over
  the mounted source). Merging promptly is what keeps the running app current.

The only reason to deviate is an explicit instruction from the operator for a specific task. When in doubt:
branch, PR, merged, pushed.

### Rule 0a — The shared index is a CONSTRAINT, not a complaint (operator, 2026-07-17)

One worktree, one index, many agents. That is settled and it is not changing — branches lost far
more code than the shared index ever will. **Do not report it as a problem, do not propose branches,
do not narrate it in summaries. Engineer around it.** The mechanics, which are not optional:

- **`git add <explicit paths> && git commit -F <msg> -- <the same explicit paths>`.** The pathspec on
  `commit` is what makes it safe: it scopes the commit to exactly those paths regardless of what else
  is staged. Never bare `git add -A` / `git commit -a` / `git commit` with no pathspec.
- **A blocked commit means RE-STAGE EVERYTHING.** If a hook rejects your commit, the index may be
  cleared by a concurrent session before you retry. Re-run the full `git add`, then
  `git show --stat HEAD` and confirm the file count is what you meant to ship. (2026-07-14: a
  rejected commit was retried and shipped ONE file — the importers of a new module landed, the module
  didn't, and `main` didn't compile for 40 minutes.)
- **Verify the COMMIT, not the working tree.** A green `npm run typecheck` / `test:unit` proves
  nothing about what you pushed — the files can be on disk and never in git. After any nontrivial
  push: `git archive HEAD | tar -x -C /tmp/v && ln -s $(pwd)/node_modules /tmp/v/ && cd /tmp/v &&
  npx tsc -p tsconfig.json --noEmit`. The pre-push hook does this automatically; do not skip it.
- **Integrating when the tree is dirty with someone else's WIP:** `git pull --rebase` refuses or
  autostashes their work (Rule-0 hazard). Check overlap first —
  `comm -12 <(git diff --name-only $(git merge-base HEAD origin/main)..origin/main|sort) <(git status --short|awk '{print $2}'|sort)`
  — and if it's empty, `git merge origin/main` integrates without touching their files.
- **A push race is normal, not an incident.** `cannot lock ref` / `fetch first` means another agent
  pushed mid-operation: re-fetch, re-check overlap, merge, push again. Do it silently.
- **Working together > detecting collisions.** Claim files in COLLABORATE.md before you touch them,
  keep claims narrow, release them the moment you're done, and read the thread before you start.

One-time local setup so the versioned guard hooks run (conflict-marker + WIP-commit blockers):
`git config core.hooksPath .githooks`

### Rule 0b — The trunk cutover (ADR-115) — DONE 2026-07-23

**The cutover has run.** This repo (`emeraldcoastsystemsgroup/oshal`) is the core trunk; the private
`open-shal` is a reference archive. Read [ADR-115](docs/adr/115-clean-trunk-branch-strategy.md).

| | before | now |
|---|---|---|
| core trunk | `open-shal`, work on `main` | **this repo**, work on a branch |
| store trunk | `oshal-applications`, work on `main` | `emeraldcoastsystemsgroup/oshal-apps` *(still to cut over)* |
| how work lands | push to `main` | open a PR, merge it |
| private repos | the trunks | reference archive + the internal-only trees |

**Two things still live ONLY in the private archive** and are not here by design: the internal-only
trees the publish gate refuses (`ralf/`, `docs/evidence/`, `scripts/release/`) and the operator-local
secrets that never travel through git (`.env`, `config-seed/secrets.json`,
`config-seed/claude-credentials.json`). A fresh clone of this repo needs those copied in before the
stack will run.

What does NOT change: pull before you start, commit small and often, push promptly, claim files in
`COLLABORATE.md`, never reset away from another agent's work, never force-push a shared branch.
Branches reduce index contention; they do not replace claiming.

**There is no rebase of private history onto the clean repo, ever.** The clean repo's value is that
no dirty commit has ever touched it — a Headscale key survived a history squash because it was in the
*tree*, and a force-push leaves every old commit fetchable by SHA. "Replay onto the clean base" means
one gated snapshot commit, which is what `scripts/release/cutover-to-clean-trunk.sh` does.

**A cutover needs a QUIET SWARM** — no unreleased COLLABORATE claims, no recent commits, clean tree.
`scripts/release/cutover-to-clean-trunk.sh` refuses to run otherwise, and that refusal is
load-bearing: a snapshot taken mid-flight silently strands work another agent has not pushed yet.
The store cutover still has to clear that bar.

After cutover there is no sanitizer between a commit and the world. `scripts/publish-gate.sh` is the
wall instead — fail-closed on every push. Never bypass it, never "fix" it by narrowing a pattern to
the file that tripped it. Gate on the identifier, not on where it has appeared.

### Rule 0c — Application code NEVER mixes with swarm code

**The swarm repo ships the platform. Applications ship from the store repo.** ADR-085 spent 21
carves separating them and the public core snapshot is app-free *by construction* — one application
mixed back in is a release defect you find in the published artifact.

- An **`oshal-app.yaml` is a store package.** If you are creating one, you are working in
  `oshal-applications`, not here. There must be zero tracked in this repo.
- **`swarm-apps/*.yaml` is exactly ten manifests** — the kernel-resident core-platform apps. A new
  ticket type / workflow / surface is a store package, not an eleventh manifest. Widening that set
  is an ADR-level decision, not a convenience.
- `apps/` and `deployed-apps/` are runtime staging in the workspace volume. Never tracked.
- A package reaches kernel capability through `uses:` (kernel skills, ADR-090), never by copying
  platform code into itself.

Enforced by `node scripts/check-repo-separation.js` — a `ci-local.sh` gate, an Actions step, and
`tests/unit/repo-separation.spec.ts` (which proves it goes red on each violation shape). If it fires,
the fix is to move the code to the right repo, not to widen the allowlist.

## What this project is

**OSHAL** (Open Swarm Harness Agent LLM) — a multi-agent orchestration platform. A swarm controller accepts tickets, dispatches phases to bot-node workers, and each bot node runs a different agent harness (Cline, Claude Code, Codex, Gemini) against a different LLM provider. Bots collaborate via Redis Streams.

See [README.md](README.md) for the operator-facing architecture diagram, compose service list, env var reference, and envelope lifecycle. The notes below are what isn't obvious from the README.

## Two runtimes, one image

There is a single Docker image ([Dockerfile.oshal](Dockerfile.oshal)); the local installer and primary compose stack tag it `oshal-bot:latest`. Some incident/evidence profiles may retag the same image for their own compose files, but the runtime split is the same. `oshal-bot:latest` is the only sanctioned tag — never reintroduce retired legacy tag names. Which process runs is decided at container start by [scripts/bot-entrypoint.sh](scripts/bot-entrypoint.sh) reading `BOT_RUNTIME`:

- `BOT_RUNTIME=swarm` → [src/app/server.ts](src/app/server.ts) — cockpit, API, queue manager, phase routing. **Never calls an LLM.**
- `BOT_RUNTIME=bot-node` → [src/app/bot-node-server.ts](src/app/bot-node-server.ts) — SwarmAgentWorker + any-bot providers. **Owns all LLM execution.**

Keep this separation. The swarm controller orchestrates; the bot nodes execute. Do not add LLM calls to the controller path, and do not add queue-manager/cockpit logic to the bot-node path.

Some lightweight personas (e.g. `codex-packer`, registered with `container: 'oshal-api'` in [src/app/extensions/swarm/swarm-bot-registry-local.ts](src/app/extensions/swarm/swarm-bot-registry-local.ts)) run **inline in the api container** rather than a dedicated bot-node — the dispatcher invokes codex CLI in-process for them. Use this pattern for personas that don't need their own LLM provider config.

## Two codebases in one repo

- **TypeScript ([src/](src/))** — swarm controller, cockpit, routes, features. Follows Feature-Sliced Design.
- **JavaScript ([any-bot/server/](any-bot/server/))** — battle-tested LLM execution (ClineProvider, ClaudeCodeProvider, TaskController). Bot nodes bridge from TS envelopes into this JS layer via [src/app/bot-node-execution-handler.ts](src/app/bot-node-execution-handler.ts).

### Harness inventory

`HarnessType` union in [harness-adapter.ts](src/features/llm-provider/services/harness-adapter.ts) — five concrete + one no-op:

| harnessType | runtime | auth | adapter |
|---|---|---|---|
| `cline` | Cline CLI subprocess | provider-specific via secrets.json | `cline-provider` (legacy default) |
| `codex-cli` | OpenAI Codex CLI subprocess | `~/.codex/auth.json` (ChatGPT OAuth) or `OPENAI_API_KEY` | `codex-cli-harness-adapter.ts` |
| `claude-code` | Anthropic Claude Code CLI subprocess | `~/.claude/.credentials.json` (OAuth) or `ANTHROPIC_API_KEY` | `claude-code-cli-harness-adapter.ts` |
| `gemini-cli` | Google Gemini CLI subprocess | `~/.gemini/oauth_creds.json` or `GEMINI_API_KEY`/`GOOGLE_API_KEY` | `gemini-cli-harness-adapter.ts` |
| `a2a` | External A2A agent over JSON-RPC HTTP | endpoint + bearer token from registry/env | `a2a-harness-adapter.ts` |
| `noop` | no-op for tests / local dev | none | `noop-provider.ts` |

The three CLI-spawn harnesses (codex / claude / gemini) extend `BaseCliHarnessAdapter` for shared subprocess plumbing — adding a new CLI-spawn harness should follow that pattern, not reimplement it. See [docs/adr/033-multi-harness-execution-framework.md](docs/adr/033-multi-harness-execution-framework.md) for the architectural rationale and the extension pattern.

`HARNESS_FACTORIES` in [provider-runtime.ts](src/app/composition/provider-runtime.ts) is typed `Record<HarnessType, HarnessFactory>` — adding a value to the union without a factory entry is a compile-time error.

Providers (Layer 0) include the hosted vendors **and** local runtimes — Ollama, LM Studio, and LiteLLM are wired in [provider-definitions.ts](src/features/llm-provider/services/provider-definitions.ts); Llama and Mistral run fully local via Ollama. `gpt-oss-120b` is offered via Cerebras (not self-hosted). A repeatable all-local swarm profile is roadmap work — see [ROADMAP.md](ROADMAP.md).

The swarm dispatches to any-bot nodes; the swarm itself never calls an LLM. When adding new execution paths, build sibling implementations behind the existing provider/harness interfaces — do not modify the hardcoded JS providers in place.

## Building an application: the bot owns the domain, the surface is a view

**Read [docs/adr/036-bot-owned-application-architecture.md](docs/adr/036-bot-owned-application-architecture.md) before building any app feature.** The shortcut of doing data-fetch or LLM work in the controller/API is **wrong** — it bypasses cost capture (`chat_tasks`), per-bot harness/model settings, and per-user ownership. The rules:

- **The bot owns its domain** — it fetches data (via its tools + the per-user connector token), **stores it in a `user_sub`-keyed encrypted store**, and does all reasoning. The surface (ribbon `ui.static`) is a **view** over the bot's store. The bot must be a real node (container + registry + persona, heartbeating) — never an inline stub.
- **Separate data-access from reasoning.** Raw reads = cheap I/O the bot caches; reasoning = LLM work that **always runs on the bot** so cost + settings apply.
- **Interactive → direct sync call:** `BotNodeClient.execute(agentId, prompt)` → bot `POST /api/swarm-execute`. Cost auto-tracked via `recordCost` → `chat_tasks`. **No queue.**
- **Scheduled / swarm-initiated → dedicated `ticketType` + workflow** → the same bot endpoint (don't borrow `incident-rca`).

Both transports hit the same accountable bot. See the ADR for the rails to reuse and the new-app checklist.

**Apps are bundled into swarms by type** — [ADR-038](docs/adr/038-swarms-bundled-by-type.md): an app = a category bundle of {connectors per provider + provider CLIs the bot runs + bot(s) + a cockpit surface}. **Every manifest also declares `suite:`** — [ADR-097](docs/adr/097-app-suites-primary-categorization.md): exactly ONE primary catalog shelf (`ai-productivity` | `ai-knowledge` | `ai-finance` | `ai-creative` | `ai-home` | `ai-engineering`; `platform` reserved), chosen by who the app serves, never derived from tool `category:`. Unknown values fail the load; suite is grouping metadata only — never re-bundle packages by suite. The **email/Intelligent Communication swarm** ([ADR-037](docs/adr/037-communications-swarm.md)) is the **reference implementation** — Gmail via a per-user connector, a **codex** bot that runs `scripts/oshal-gmail.js` itself in its sandbox (codex is a first-class bot-node harness; claude-code-as-root can't shell out), and the cockpit surface. Adding a provider = a connector + a `scripts/oshal-<provider>.js` CLI, never a new app. The **social** bundle (publish to LinkedIn/X/Facebook Pages + the inbox-fed Signals feed), **storage**, and **presentations** bundles are now built; **devops/Vault** is a Private Preview facade ([ADR-040](docs/adr/040-devops-vault-swarm.md), runtime is the build); smart-home + the privileged-runtime security model remain roadmap — see the ADRs + [BACKLOG.md](docs/BACKLOG.md).

## Architectural default: one bot per ticket-type workflow

Each ticket type maps to **one workerBot** whose persona embeds the full quality gate (Mode A/B/C classification, citation rules, structured artifact set including HANDOVER.md, mode-specific scripts). The persona is the swarm. There is **no external Phase-2 reviewer by default**.

Built-in workflows in [WORKFLOW_PIPELINES](src/features/swarm-orchestration/services/queue-manager-service.ts) (`incident`, `build`) declare only `workerBot`. Manifests in [swarm-apps/](swarm-apps/) register additional ticket types (e.g. `incident-remediation` via `intelligent-operations.yaml`) the same way.

Manifests CAN opt in to a separate reviewer by declaring `reviewerBot` + `maxRevisions`. Default is no reviewer. Don't add a queue-bot review unless the worker persona genuinely can't self-gate.

The dispatcher (`chooseDispatchPath` in queue-manager-service.ts) routes:
- `pipeline: 'incident-rca'` → `dispatchIncidentTicket` (single-bot, optional reviewer)
- non-build manifest with `workerBot` → `dispatchManifestWorkerTicket`
- otherwise → `dispatchTicket` (build/swarm pipeline)
- **app-contributed ticket type with no registered manifest yet** → defer to next poll cycle (startup race guard against `swarmAppService.autoLoadAll()` racing `queueManagerService.start()`)

## Feature-Sliced Design (TypeScript side)

Layer import direction is strictly top-down:

```
app/ → pages/ → features/ → entities/ → shared/
```

- Every directory exports through an `index.ts` barrel. **No deep imports** (`@/features/foo/services/bar` is wrong; `@/features/foo` is right).
- Path aliases live in [tsconfig.json](tsconfig.json): `@/app/*`, `@/pages/*`, `@/features/*`, `@/entities/*`, `@/shared/*`.
- One primary entity per file (one class, one component, one service).
- No cross-imports between slices at the same layer.

## Hard file/function limits

- **1000-line hard cap** on any file — no exceptions. Measured in **lines of code**:
  comments and blank lines don't count, and `.html` / `.md` files are exempt entirely
  (operator clarification 2026-07-05).
- At **800 code lines**, stop and propose a decomposition plan before adding code.
- Keep functions **under 50 lines**. Extract helpers rather than growing a function.
- Applies to source, tests, and logic-bearing config.

## File headers (Change Log)

Every `.ts` / `.js` / `.jsx` / `.tsx` / `.sh` / `.sql` / logic-bearing config file starts with a Change Log block. Format is exact:

```typescript
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation
 */
```

- Author is always `maintainer@emeraldcoastsystemsgroup.com` (exact, case-sensitive) — never "Cline", "AI", "Claude", "System".
- Entries are sequential integers (1, 2, 3, …) in the first column — no timestamps or dates.
- New entries append at the bottom; describe *what changed and why*, not "updated file".
- Exemptions: pure data files (`.json`, `.env`), generated files, markdown.

Every exported member needs JSDoc with `@description`, `@param`, `@returns`. Explain the *why*, not a restatement of the code.

## Authentication is opt-in per route

[src/shared/middleware/oidc.ts](src/shared/middleware/oidc.ts) configures `express-openid-connect` with `authRequired: false`. That means every Express route is **publicly callable by default** unless explicitly wrapped in the `requiresAuth` middleware. When adding a new route:

```ts
app.use('/api/foo', requiresAuth, createFooRoutes());          // good
registerFooRoutes(app, requiresAuth, deps);                    // good — accept requiresAuth as a param
app.use('/api/foo', createFooRoutes());                        // BAD — anonymous-callable
```

If a route exposes workspace paths, file content, persona details, or runs an LLM / creates a ticket: it MUST be auth-gated. Sanity check via the patterns in `tests/security-review-fixes.spec.ts`.

## Partner-app registration: business email + one repeatable pattern

When a connector needs an app registered on a partner site (Google, Meta, Microsoft, SmartThings, Nest, …), **always register it under the business email `maintainer@emeraldcoastsystemsgroup.com`** — never a personal address. That account owns the verification mail, security alerts, and app-review correspondence for every partner.

The registration steps are the same every time and are documented once in [docs/partner-app-registration.md](docs/partner-app-registration.md): two shapes (A = OAuth client + redirect `https://oshal.example.com/api/connect/<id>/callback`; B = pasted Personal Access Token), a per-platform appendix, and a fill-in template for new connectors. Claude writes the connector code; the human only registers the app and pastes the credentials. **No connectors to nowhere** — only wire a connector whose token drives a real usable API (this is why Alexa is documented-but-staged: third-party Alexa device control needs a certified Smart Home Skill, not a public REST API).

## RAG corpus + embeddings

ChromaDB lives at `oshal-chromadb:8000` in compose, port-mapped to `localhost:58001`. One collection:
- `infra-runbooks` — generic infra docs (k8s, databases, etc.)

Collections are created with `embedding_function=DefaultEmbeddingFunction()` (`all-MiniLM-L6-v2` ONNX, ~80MB cached at chroma container startup). Server-side embedding handles both ingest + query. If a collection somehow lacks an embedding function, [src/features/rag/services/rag-service.ts](src/features/rag/services/rag-service.ts) falls back to BM25 lexical scoring with doc-level aggregation — usable but not as good.

To rebuild collections with embeddings (after a collection drift):

```bash
bash scripts/rag-enable-embeddings.sh
```

Personas that need RAG should curl `http://oshal-local-api:5000/api/rag/search?q=...&collection=...&topK=5` from their bash tool. Citation blocks must use `doc_id` from the corpus; web-fetched content uses a `web:` prefix on `doc_id` to mark provenance.

## Cockpit URL contract: `?app=` is the single source of truth

[src/pages/cockpit/js/components/RibbonNav.js](src/pages/cockpit/js/components/RibbonNav.js) reads `?app=<manifest-name>` (or legacy `?profile=<name>`) from the URL on every page load. **No localStorage caching of profile name** — earlier builds did, which poisoned plain `/cockpit/` visits with the last-used app shape. URL is authoritative; bookmark it if you want it sticky.

- `/cockpit/` (no params) → framework-default ribbon (Tickets / Chat / Calendar / Dashboard / etc.).
- `/cockpit/?app=intelligent-operations` → ticket list pre-filtered to the manifest's `ticketType` field.

## Naming

**oshal** is the product name, written **lowercase** in user-facing copy (operator directive 2026-07-24). There are exactly two sanctioned ways to reference the product: **"oshal"**, or **"open swarm oshal"** — "open swarm" must NEVER stand alone as the name; if the phrase appears, "oshal" follows it. Existing technical identifiers keep their forms (`OSHAL_API`, `oshal-local-db`, `Install-OSHAL.bat`, app display names like "OSHAL Assistant"). oshal is the only product name this codebase has ever shipped under — never reintroduce any retired pre-oshal name in code, tags, identifiers, or docs.

## No mock/stub deliverables

Bot-generated code must be real, functional implementation. Mock/stub output is only acceptable when the ticket description explicitly says "prototype", "scaffold", "mock", "stub", "POC", or "skeleton". This rule applies to you too when writing code — no `// TODO` shells, no hardcoded return values standing in for logic, no "example" skeletons. If context is missing, escalate; don't fake it.

## Logging: structured JSON, no silent catches

- Use the project's Pino logger: `createChildLogger({ module: '...' })` from `@/shared/logger`. Never `console.log` in production code.
- Every public method and API route logs entry/exit with sanitized params and duration.
- Every `catch` block logs at ERROR with the error and stack trace. No swallowed exceptions.
- Never log API keys, tokens, or secrets.

## Local dev and testing

### Run the stack

```bash
# Full Docker stack (controller + Postgres + Redis + ChromaDB + bot containers)
docker build -f Dockerfile.oshal -t oshal-bot:latest .
docker compose -f docker-compose.oshal-local.yml up -d
# Cockpit at http://localhost:35457
```

**After a Docker Desktop / engine restart, bring the stack up with [scripts/oshal-up.sh](scripts/oshal-up.sh), not a bare `compose up`.** On engine restart, containers auto-start out of order: Postgres/Chroma can crash (exit 255) and the API comes up DB-less while still reporting "healthy" (its healthcheck is shallow HTTP). `oshal-up.sh` enforces the correct order — infra healthy → **API fully up (healthy + swarm-app auto-load complete)** → bots last — and prints status + the cockpit URL.

```bash
bash scripts/oshal-up.sh
```

If `localhost` URLs stop responding (fully or under parallel load) while `docker ps` shows the api healthy, check whether `127.0.0.1:<port>` still works. If it does, a stale `wslrelay.exe` is squatting on the IPv6 loopback `[::1]` for the published ports — browsers hit it via `localhost` → `::1` and hang (root-caused 2026-06-12; previously misattributed to vpnkit). Fix: `Stop-Process -Name wslrelay -Force` in PowerShell — container bounces and Docker Desktop restarts do NOT clear it. Full diagnosis steps in [docs/runbooks/localhost-wedge-wslrelay.md](docs/runbooks/localhost-wedge-wslrelay.md). If `127.0.0.1` is also dead, it's the classic forward wedge — recover with:

```bash
bash scripts/api-bounce.sh
```

### Block stale browser-tab loop tickets

A stale browser tab somewhere in operator history POSTs `loop-(build|incident|rca)-NNNNNN` synthetic tickets every couple minutes. To block them at the route level, set `REJECT_LOOP_TICKETS=true` in `.env`. The api returns HTTP 429 for any title matching `^loop-(build|incident|rca)-\d+$`.

### Tests

Playwright is the primary test runner. The webServer config in [playwright.config.ts](playwright.config.ts) boots `src/app/server.ts` via ts-node — for source-level + isolated tests you don't need the docker stack.

```bash
# Type check the TypeScript side
npx tsc --noEmit

# All Playwright tests against an isolated server (no LLM cost)
FORCE_LLM_PROVIDER=noop npx playwright test

# Single test file against an isolated server
npx playwright test tests/swarm-e2e-pipeline.spec.ts
```

### Tests against the live docker stack

For tests that need the running container's actual data (RAG search, dispatcher behavior, real ticket lifecycle):

```bash
PLAYWRIGHT_PORT=35457 PLAYWRIGHT_REUSE_SERVER=true MOCK_OIDC=true \
  npx playwright test tests/rag-bm25-ranking.spec.ts
```

**Deploying source changes: use the one verified deploy command.** It builds from committed HEAD, verifies the image (commit label + kernel-skills probe), recreates api-then-bots classified by image (infra can't be swept in), hard-gates on parity + health, and auto-rolls-back to the pre-deploy image on failure. `--dry-run` prints the plan touching nothing:

```bash
bash scripts/oshal-deploy.sh            # commit + push first — it deploys committed HEAD
```

Don't hand-roll `docker build` + `compose up --force-recreate` sequences — a hand-typed recreate filter took down the infra tier on 2026-07-19; the script exists so that class of mistake can't recur. Bind-mounted directories (cockpit JS, persona YAML) update without rebuild. (`oshal-up.sh` stays the bring-up/recovery path after an engine restart; `oshal-deploy.sh` is for shipping new code.)

If you do recreate something manually, run `bash scripts/deploy-parity-check.sh` after — it flags the api and bot-node containers drifting onto different image builds (the split-image bug where a two-half feature ships broken). `oshal-up.sh` runs it automatically. Runbook: [docs/runbooks/deploy-parity.md](docs/runbooks/deploy-parity.md).

The `tests/unit/**` subtree is excluded from the Playwright runner; Playwright is e2e-only here.

### Guard-per-fix (operator directive, 2026-07-19 hardening)

Every bug you fix ships a regression guard in the SAME change — a unit spec, an e2e case, or a CI
gate that would go red if the bug returned. Every critical path needs a named guard (the 2026-07-19
sweep added them for route auth inventory, graph-key derivation, token-broker SQL scope, the
devops-vault gate, the controller/LLM boundary, and log redaction — extend that set, don't orphan
it). Two corollaries: a spec that SKIPS in CI is a guard that doesn't exist (fail loudly when the
gate env is missing instead), and a red gate nobody acts on trains everyone to ignore red — fix it
or explicitly quarantine it with a BACKLOG entry the same day.

### Human testability gate

At any handover point the system must be operable by a human from `localhost` without unavailable external services. OIDC is required in prod, but local dev must work with `MOCK_OIDC=true`. Don't mark a task complete unless a human can log in and exercise the feature in a browser.

## Key directories

- [src/app/](src/app/) — entrypoints ([server.ts](src/app/server.ts), [bot-node-server.ts](src/app/bot-node-server.ts)), [composition-root.ts](src/app/composition-root.ts), [extensions/swarm/](src/app/extensions/swarm/) (swarm boot, bot registry), [routes/](src/app/routes/) (all Express route registrations).
- [src/features/](src/features/) — feature slices: `swarm-orchestration`, `agent-management`, `llm-provider`, `ticketing`, `intake`, `chat-orchestration`, `tool-registry`, `rag`, etc.
- [src/pages/](src/pages/) — route-level UI compositions (cockpit, chat, swarm-control, workflow-studio, task-explorer, queue/mesh/ops dashboards).
- [any-bot/server/](any-bot/server/) — JS LLM execution layer. `services/llm/` has `ClineProvider`, `ClaudeCodeProvider`, `LLMProviderRegistry`. `controllers/TaskController.js` is the routing core.
- [ai-lab/bot-personas/](ai-lab/bot-personas/) — persona YAML files consumed by bot nodes at prompt-assembly time. The `perspective:` block is the bot's full system prompt, including its quality gate.
- [swarm-apps/](swarm-apps/) — application manifests that contribute new ticket types + workflows + bots + UI surfaces. See `intelligent-operations.yaml` for the incident bundle; `eats.yaml` for an app with custom ribbon UI. (little-monsters was carved out to the oshal-applications store repo — ADR-085.)
- [config-seed/](config-seed/) — `global-config.json`, `secrets.json` (provider creds), `claude-credentials.json`. Shared across containers.
- [scripts/](scripts/) — `bot-entrypoint.sh`, setup scripts, migrations, port-forwards, bot lifecycle helpers, `oshal-up.sh` (ordered bring-up after an engine restart), `api-bounce.sh`, `rag-enable-embeddings.sh`.
- [tests/](tests/) — Playwright e2e specs.
- This file is the canonical governance guide for repo agents. If repo rules change, update this file.

## Bot registry (mix-mode)

Bots are declared in [src/app/extensions/swarm/swarm-bot-registry.ts](src/app/extensions/swarm/swarm-bot-registry.ts) (and `swarm-bot-registry-local.ts` for the local variant) with `harnessType` and provider. Bots without an explicit harness fall back to the process-level `FORCE_LLM_PROVIDER` (default `openai-codex`). UUIDs must match across: compose file, registry, Redis heartbeats (`oshal:runtime-agent:{agentId}`), and Postgres. When adding a bot, update registry + compose + persona YAML together.

**Before adding a bot, read [docs/building-a-bot.md](docs/building-a-bot.md).** A bot must take one of two forms — a **dedicated any-bot-swarm node** (own container; for shell-out / device / heavy-store bots) or a **concierge node** (inline on the api, reached via `POST /chat`; for reason-only bots). Register in **both** registry files. Everything is **BYOK on the swarm default login** (the mounted `~/.claude` / `~/.codex` / `~/.gemini` OAuth) — never add a vendor API key to a bot's env. Don't improvise a third "call it from one route" shortcut.

## Handover artifacts

- Feature-level state → `HANDOVER.md` in the feature/module directory (Status, Dependencies, Technical Debt, Next Steps). NOTE: `**/HANDOVER.md` is gitignored — these are local-only by design.
- Session-level workflow → briefs in ralf/.
- Project-level decisions → ADRs in [docs/adr/](docs/adr/) (format `NNN-short-title.md`, Context/Decision/Consequences).
- Deferred work → [BACKLOG.md](docs/BACKLOG.md). Each entry has done-when criteria so future Claude doesn't have to guess scope.
- New documentation → a **topic folder** under `docs/` (security/, release/, business/, apps/, runbooks/, backlog/, architecture/, …) and an entry in that folder's `README.md`. Never add files to the `docs/` top level — it is reserved for the canonical guides indexed in [docs/README.md](docs/README.md). Verify links with `node scripts/docs-link-check.js`.

## Graph extension (ADR-045)

OSHAL has an **optional** graph tier for relationship-heavy data (RCA topology, jobs↔companies↔recruiters, capture teaming) where graph beats relational. It is an **extension layer**: absent by default (the connector returns `null` / `/api/graph` returns **503** when `ARANGO_URL` is unset), and the engine is just a URL — local, remote, on-prem, or a customer-landscape instance.

- **Engine:** ArangoDB Community (`oshal-arangodb` in compose, host port 58529) — free multiple-databases-per-instance, no Enterprise license. Pin `arangojs ^8` (v10 is ESM-only; this project compiles CommonJS).
- **Two tiers (mirrors storage/tenancy):** a per-person graph (`getPersonGraph(sub)`) and a shared per-tenant graph (`getTenantGraph(tenant)`), each an **isolated ArangoDB database**. Names derive ONLY from sub/tenant ([graph-keys.ts](src/features/graph/services/graph-keys.ts)) — the isolation boundary; treat like the token broker.
- **Engine-agnostic connector** ([src/features/graph/](src/features/graph/)): bots use the plain `GraphHandle` (`upsertNodes`/`upsertEdges`/`neighbors`/`shortestPath`/`rawQuery`). Swapping engines = one new adapter, nothing else. Live-verified via [scripts/graph-smoke.ts](scripts/graph-smoke.ts).
- **Bots reach it via `/api/graph`** (auth-gated, caller-scoped — never raw DB creds), replacing the retired legacy graph route. Query language is **AQL**, not Cypher.
- **Don't force graph where relational fits** (ADR-045 "Adoption"). A new domain graph is ingestion + NL queries over the SAME connector — never a new service. Generalizes to "add a DB → mint a management bot" (ADR-045 #6).

## External services to be aware of

- **Redis mesh channel format**: `oshal:mesh:agent.{agentId}` (XADD/XREADGROUP). Heartbeats at `oshal:runtime-agent:{agentId}`. This is the **internal** swarm coordination path.
- **A2A surface** for **external/remote** agents lives in [src/shared/types/a2a.ts](src/shared/types/a2a.ts) (transports `headscale-http`/`http`/`sse`/`stdio`) with a remote-client MCP bridge in [src/features/remote-client/](src/features/remote-client/). Keep the two distinct: in-swarm bots use the Redis mesh; external agents use A2A. The A2A gateway is not yet production-proven — see [ROADMAP.md](ROADMAP.md).
- **Postgres** holds tickets, agents, work items, and `chat_tasks` (per-call cost/tokens — query this for canonical $-cost numbers, not log estimates).
- **ChromaDB** at port 58001 for RAG and swarm memory.
- **Code-server** at port 8444 mounts the shared workspace; cockpit workspace links redirect through the `/code` bridge route.

## TTS / voice is pluggable

Never hardcode AWS Polly credentials or a specific TTS vendor into bot nodes. TTS must be a pluggable harness, parallel to how LLM providers work — build siblings behind an interface rather than injecting into one vendor.

## Documenting features: as-built, not aspirational

Docs describe what works **today**. Vision and partially-built items belong in [ROADMAP.md](ROADMAP.md) (today/target per item) and [BACKLOG.md](docs/BACKLOG.md) (done-when criteria) — not in feature docs written as if shipped.

**Anti-drift rules (added after the 2026-07-18 honesty sweep — a 6-bucket adversarial docs audit that found the corpus *under-sold* shipped features more often than it over-claimed; see [docs/operations/bug-log.md](docs/operations/bug-log.md) BUG-1):**

1. **No competitive absolutes on any surface.** Never "only / no one else / nobody else / no other / unique / exclusive" as a competitive claim — in any doc, deck, whitepaper, site, or persona. State the category/architecture truth; if a rival structurally *can't* do it, say **why**. And **verify a claim is actually false before cutting it** — the honesty doc's own "cut the routing claim from the site" instruction was wrong (harness-layer routing is real and unrefuted; the fix was to reinstate it at the right layer, not delete it).
2. **Counts are generated, never hand-typed.** Bot / persona / app / provider / ADR / connector counts come from the counts generator run against the tree — never a literal number in prose. (Hand-typed "26 bots / 68 personas / 45 connectors" is how three docs drifted up to 6.8× off reality.)
3. **Ship a feature → reconcile its collateral in the same change.** When a capability goes roadmap→shipped, update README + ROADMAP + whitepaper + assets + the ADR index in the *same* commit. Dated snapshots (decks, scorecards) must regenerate, not carry hand-typed truth.
4. **"Not yet built" about shipped code is as dishonest as the reverse.** Under-claiming costs the same credibility as over-claiming — sweep both directions.
5. **Financial / performance figures need a traceable source + a posture label.** No unsourced return numbers; label paper vs live explicitly; never imply a live track record when the posture is paper.
6. **The scorecard must fail loud.** The evidence nightly compares to the last committed board and exits non-zero / alerts when a category decays or a proof generator fails — never silently exit 0, and never publish a number the working tree contradicts.

Specifics that are easy to overstate:

- **Workflow Studio authoring is design-time; Publish now compiles to runtime.** `/workflow-studio/` authors and validates workflow graphs. The **Publish** action is live: it compiles a definition to a caller-scoped manifest and loads it as a real ticket queue (single-shot → `manifest-worker`, multi-stage → the `staged` executor with per-stage approval gates, and a full branching/parallel canvas → an executable nodeGraph on the process-definition engine, shipped 2026-07-05), alongside the workflows registered from `swarm-apps/*.yaml` via `WorkflowPipelineRegistry`. A natural-language **talk-to-build** assist drafts the canvas graph; only agentic authoring that composes **brand-new** agents/goals from a prompt is still roadmap. Don't treat the studio as a second orchestration engine: the runtime (queue-manager + registry) stays the authority; Publish emits into it, it does not replace it.
- **Harness packing is real.** `codex-packer` ([ai-lab/bot-personas/codex-packer.yaml](ai-lab/bot-personas/codex-packer.yaml)) interviews an operator and emits a packed single-purpose bot (persona YAML + `swarm-apps/*.yaml` manifest + optional KB), registered live via `POST /api/swarm/apps/load`. A whole business process becomes one self-contained bot — the packed-bot pattern every package in the [public app store](https://github.com/emeraldcoastsystemsgroup/oshal-apps) follows (the original federal-capture exemplar is a commercial package in the private repo). The **skill-import adapter** ([ADR-089](docs/adr/089-skill-import-adapter.md), [src/features/skill-import/](src/features/skill-import/) + [scripts/skill-import.ts](scripts/skill-import.ts)) is the non-interactive sibling: it absorbs an external Agent-Skills `SKILL.md` into the SAME persona+manifest shape, security-gated (bundled scripts quarantined, tools translated+minimized, emitted `inactive` for operator review).
- **Login lands on the plain cockpit** (`/cockpit/` — operator decision 2026-07-07, superseding 2026-07-06's "Jarvis first screen"): bare `/` opens the framework ribbon shaped by the user's authorizations; an explicit `?app=<name>` in a URL is always respected; override per deployment via `LANDING_PATH`. Haven = Jarvis + the ADR-079 user model; ADR-030's remaining open items are listed in its status line.
