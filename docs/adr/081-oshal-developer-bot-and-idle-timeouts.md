# ADR-081: The OSHAL Developer Bot (in-swarm platform development) + idle-based CLI harness timeouts

**Status:** Accepted (2026-07-07)
**Relates to:** ADR-077 (self-developing platform / dev console), ADR-036 (bot-owned apps), ADR-045 (graph extension)

## Context

On 2026-07-06 the operator asked Jarvis to "add Google Drive to our files application."
Three separate failures compounded:

1. **Misroute** — the deterministic task selector matched the bare keyword
   `application` and pinned the ticket to **career-advisor** (the job-hunt bot).
2. **Duration timeout killed active work** — the codex run (which had correctly
   found the repo and was implementing the feature) was SIGTERMed by the harness's
   absolute 600s timer *mid-typecheck*, twice. The timer measured duration, not
   health: the process was streaming events the whole time.
3. **Unisolated writes** — the misrouted errand bot edited the **live working
   tree** through the host-repo mount + `danger-full-access` sandbox. The work
   happened to be good; nothing guaranteed that, and nothing reported it.

Meanwhile ADR-077 already established the self-development frame: a **host
sidecar** dev-node with governed worktrees, a locked-down sandbox, and explicit
operator approval — because "the thing that fixes the swarm cannot live inside
the swarm." That constraint is about the **recovery muscle** (rebuild the image,
restart the stack). It says nothing against a swarm-resident bot doing ordinary
**feature work** the way every other agent in this trunk-based repo does: in a
checkout, through the guard hooks, pushed to main.

## Decision

### 1. A dedicated, pre-loaded platform-development specialist: `oshal-developer`

A first-class bot-node (agent `de000000-0000-0000-0000-000000000001`, container
`oshal-developer`, harness `codex-cli`) that owns ticketType **`oshal-dev`** via
the single-bot manifest-worker dispatch ([swarm-apps/oshal-dev.yaml](../../swarm-apps/oshal-dev.yaml)).

- **Its own clone, never the live tree.** `bot-entrypoint.sh` clones
  `OSHAL_DEV_REPO_URL` (default: this repo; **configurable per deployment**) into
  the `oshal-dev-repo` named volume at `/app/dev-repo`, refreshed on every boot
  and re-pulled at the start of every ticket. The deployed runtime and the
  hot-swap-mounted host tree are out of bounds — that preserves ADR-077's
  load-bearing isolation (a live-tree edit deploys instantly and unreviewed).
- **Pre-read into the architecture.** The persona
  ([ai-lab/bot-personas/oshal-developer.yaml](../../ai-lab/bot-personas/oshal-developer.yaml))
  embeds the architecture map (two runtimes, FSD layers, registries, manifests),
  the docs map (CLAUDE.md → docs/README.md → ADRs → BACKLOG/ROADMAP), the full
  quality gate (change-log headers, tsc, unit suite, file caps, no mocks), and
  Rule 0 (main-only, small commits, push immediately, guard hooks on —
  `core.hooksPath .githooks` is set in the clone).
- **Push auth** via `OSHAL_DEV_REPO_TOKEN` through an env-reading credential
  helper — the token is never written to `.git/config` or embedded in the remote
  URL. Git identity: the standard business identity.
- **Duties beyond tickets:** a nightly docs-quality ticket (04:00,
  `workflow:oshal-dev` schedule, registered at boot when `OSHAL_DEV_OWNER_SUB`
  is set) and a continuously-maintained **codebase index graph** in the bot's
  person graph via `/api/graph` (nodes: feature/route/bot/manifest/adr; edges:
  contains/registers/documents/depends-on).

### 2. Direct routing + a superadmin gate

- Jarvis's task selector recognizes platform-dev asks **first** (explicit tokens
  like `oshal`/`cockpit`/`swarm-app`, or verb+into+"our app/platform/api" shapes)
  and files them as ticketType `oshal-dev` pinned to the developer bot — the
  target-routing pattern the operator called for: a specialist that "gets the
  call," not a keyword lottery across domain concierges.
- **`oshal-dev` is privileged.** `dispatch-manifest-worker` refuses to dispatch
  it unless `ticket.ownerSub` is on `OSHAL_SUPERADMIN_SUBS`
  (`isSuperAdminSub()` — fail-closed, sub-allowlist only, and deliberately
  independent of `OSHAL_DEV_CONSOLE_ENABLED`, which gates the browser console).
  The set of privileged ticket types is **hardcoded** so a manifest edit can
  never widen who can task the bot. Gated at dispatch, not intake, because
  `POST /api/tickets` accepts any ticketType from any authenticated user.

### 3. Idle-based timeouts for CLI harnesses ("only time out on idle, not duration")

`BaseCliHarnessAdapter` now supports **inactivity semantics**: adapters that opt
in (`idleReset`) treat the timeout as *max silence* — every child stdout/stderr
chunk refreshes the timer — plus a `maxDurationMs` runaway backstop, and
SIGTERM→SIGKILL escalation (10s) on any timeout kill.

- **codex-cli: opted in** (`codex exec --json` streams JSONL continuously).
  Knobs: `CODEX_INACTIVITY_TIMEOUT_MS` (default 600 000 — 10 min of *silence*),
  `CODEX_MAX_DURATION_MS` (default 7 200 000 — 2 h). The legacy
  `CODEX_TIMEOUT_MS` still works but now bounds silence in the TS adapter (the
  JS bot-node path reads the same env name separately, with absolute semantics).
- **claude-code / gemini: absolute semantics retained.** Their batch modes
  (`--print --output-format json`, `-o json`) legitimately stay silent until one
  final JSON — a healthy 177s-silent run is documented in
  docs/evidence/claude-inactivity-timeout-honesty-2026-06-22.md.
  Idle-kill there would reintroduce false "stalled" failures. They can adopt
  idle semantics if/when they move to streaming output modes.

### 4. Division of labor with ADR-077 (unchanged where it matters)

| Concern | Owner |
|---|---|
| Feature work on the platform (tickets, docs, refactors) | `oshal-developer` bot, in its own clone, pushed to main |
| Recovery: rebuild image, restart stack, bring it back green | ADR-077 host sidecar (`scripts/dev-node.ts`) — survives the swarm dying |
| Browser-driven governed self-edit with approve/discard | ADR-077 Phase 2 dev-console sessions |

"Bot pushes → the swarm updates" means what it already means for every agent:
**deployment follows main**. Under the hot-swap override, `src/**` changes go
live once the host checkout pulls; baked artifacts (image COPYs, migrations,
vite dist) need a rebuild + recreate — a muscle that stays with the operator or
the sidecar, never inside the swarm.

## Consequences

- Platform-change requests land on a specialist that knows the codebase, works
  isolated, self-gates, and reports with verification evidence — instead of
  hijacking a domain concierge into unreviewed live-tree edits.
- A long, actively-streaming dev run is no longer killed at an arbitrary
  duration; only silent-stuck processes (10 min of nothing) and true runaways
  (2 h) die, with honest error messages distinguishing the two.
- Non-superadmin users who phrase something platform-shaped get a visible
  `superadmin_required` escalation, not silent execution power.
- New env surface: `OSHAL_DEV_REPO_URL/BRANCH/TOKEN`, `OSHAL_DEV_OWNER_SUB`,
  `OSHAL_DEV_DOCS_CRON`, `OSHAL_DEV_IDLE_TIMEOUT_MS`, `OSHAL_DEV_MAX_DURATION_MS`,
  `CODEX_INACTIVITY_TIMEOUT_MS`, `CODEX_MAX_DURATION_MS`.
- `/api/graph` is now reachable by bot-nodes via the trusted-service headers
  (same pattern as `/api/trading` and `/api/vids`), which the codebase index —
  and any future bot-maintained graph — depends on under real OIDC.
- The bot's clone consumes disk in the `oshal-dev-repo` volume and its runs
  consume codex quota; both are bounded by the superadmin gate on who can file
  `oshal-dev` work.
