# ADR-077 — The Self-Developing Platform: super-admin Developer Console + sidecar dev-node

- **Status:** Accepted (Phase 1 built). Phases 2–3 Proposed.
- **Date:** 2026-07-04
- **Related:** [ADR-036 bot-owned architecture](036-bot-owned-application-architecture.md), [ADR-044/047 edge-agent device-as-node](047-smart-home-edge-agent.md), [ADR-049 aggregation-platform thesis](049-oshal-as-aggregation-platform.md), [ADR-050 unified assistant](050-unified-assistant-route-orchestrator.md), [ADR-040 privileged credential broker](040-devops-vault-swarm.md), remote-client / A2A framework.

## Context

OSHAL should be a platform a super-admin can **develop from inside itself**: pull up an assistant on any screen, say *"jobs are indexing wrong — check the server logs, find the bug, fix it, recompile,"* and work with it exactly like a developer works in Cline / Claude Code — with the full reasoning chain visible and a human in the loop.

Two hard constraints shape the design:

1. **The thing that fixes the swarm cannot live inside the swarm.** A dev bot running as a swarm container dies when the swarm dies and cannot `compose up` itself back. Recovery (recompile, restart, bring the stack back green) must run from **beside** the swarm, not within it.
2. **This is the single most privileged capability in the system** — root-grade access to the source and the host. It must be **fail-closed, gated behind an explicit role, produce zero risk to an enterprise deployment that never opts in, and be fully debuggable.**

The competitive framing (see the decision brief and ADR-049): a vendor SaaS **structurally cannot** let agents rewrite it; OSHAL can, *because the customer owns the whole stack*. Making self-development a **proof-gated product capability every install ships with** is a moat no single-vendor stack can copy — and it composes with the evidence/scorecard rail (every self-edit must pass the same gates the platform already runs).

### Topology — three independent pieces, wired over the existing mesh/tailnet

- **The swarm** — Docker or k8s, hosted anywhere (a box at home, a cloud, a closet). The brain; it does not move.
- **You** — any browser on any computer. The cockpit + the global Jarvis orb come to you.
- **The chat node** — a portable app on any device (phone, another PC, or the Docker host). **What it can *do* scales with where it sits:** anywhere it can chat, diagnose, and propose edits over the mesh; sitting on the Docker host it can also recompile and reboot. Connected by LAN on the same network, or the headscale tailnet when apart — the exact rail remote nodes already run on.

## Decision

Build the **Self-Developing Platform** as a **sidecar dev-node** driven by a super-admin Jarvis, along a phased **L0→L3 trust ladder**, gated by a new **explicit super-admin role**.

### 1. The explicit super-admin role (the security spine) — BUILT

Super-admin is a **distinct, more privileged role than operator**, enforced by `src/shared/middleware/superadmin.ts`. It is **double-gated and fail-closed**:

1. **Capability enable** — `OSHAL_DEV_CONSOLE_ENABLED` must be explicitly truthy. Unset ⇒ the Developer Console does not exist for anyone. An enterprise deployment that never opts in is not exposed at all.
2. **Dedicated allowlist** — the caller's OIDC `sub`/`email` must be on `OSHAL_SUPERADMIN_SUBS` / `OSHAL_SUPERADMIN_EMAILS`. Empty ⇒ nobody qualifies.

Being an **operator does NOT grant super-admin** — a separate, explicit list, so broadening operator access can never silently widen who can touch platform internals. Both env defaults are OFF/empty in the committed compose + `.env.example`.

**Debuggability is a first-class requirement.** `evaluateSuperAdmin(req)` returns a `SuperAdminDecision` — `{ allowed, reason, checks: { capabilityEnabled, authenticated, onAllowlist }, sub }` — reporting the *first failing gate* deterministically. That trace drives:
- server logs (info on grant, warn on denial, with the full decision),
- an append-only `access_audit_log` row on **both** allow (per action) and **deny** (`dev-console.denied`, with the reason + checks),
- a caller-facing `GET /api/dev-console/access` that tells the signed-in user their own status and *why* — without ever exposing the allowlist or anyone else's identity.

### 2. Phase 1 — the Developer Console, read-only — BUILT

- **Global Jarvis orb on every page** (`src/pages/cockpit/js/jarvis-orb.js`, loaded from the cockpit shell): the assistant on every `?app=`, embedding the existing auth-gated `/api/jarvis/` surface. It reveals a **Dev diagnostics** affordance only when `GET /api/dev-console/access` reports the caller is a super-admin — a cosmetic reveal over a server-enforced gate.
- **`/api/dev-console` routes** (`src/app/routes/dev-console-routes.ts`), mounted behind `requiresAuth`; privileged routes additionally pass the audited super-admin guard:
  - `GET /access` — the caller's own decision trace (auth-only; safe).
  - `GET /status` — runtime + capability snapshot (super-admin; audited).
  - `GET /health-snapshot` — bounded, sanitized job-health counts from the task store, **no message bodies / prompts / titles / secrets** (super-admin; audited).
- **No shell, no writes, no source access** in Phase 1 — genuinely low-core-impact, and the orb is bind-mounted so it hot-swaps with no rebuild.
- Verified by `tests/unit/dev-console-superadmin.spec.ts` (8 tests): denies with flag unset even for an allowlisted caller; denies when enabled but not allowlisted; allows only enabled+allowlisted (by sub and case-insensitive email); operator ≠ super-admin; no allowlist leak in denials or `/access`.

### 3. Phase 2 — repo-scoped editing (Slice 1 BUILT: the safe governance engine)

Split into two parts by trust boundary:

**Slice 1 — the Dev Session Engine (BUILT).** `src/features/dev-console/services/dev-session-engine.ts`
governs the SAFE substrate: `create` (isolated git worktree on a `dev-session/*` branch + a
node_modules junction) → `applyChangeSet` (write a reviewed change set, path-confined) → `diff` →
`verify` (`npm run typecheck`) → `commit` (branch-only, and only for the exact tree verify passed) →
`teardown`. Driven by `npm run dev:session` on the host/sidecar node. It NEVER writes the live tree
and NEVER commits to main. Proven by 12 unit tests + a live smoke against the real repo (main
HEAD/tree/node_modules provably untouched).

**Slice 2 — the sandboxed agent runner (isolation core BUILT).**
`src/features/dev-console/services/sandboxed-agent-runner.ts` (`SandboxedAgentRunner`) runs an
untrusted edit command in a locked-down Docker container — `--network none --read-only`, only the
session scratch dir writable, `--cap-drop ALL --security-opt no-new-privileges`, no host `.git`, no
`~/.claude`, resource-limited — then extracts the resulting file changes as a reviewed change set
fed to Slice 1's governed apply → verify → commit. A container is a REAL boundary (kernel
namespaces), unlike a cwd. Proven on this host: a `selfTestIsolation()` adversarial probe reports
every escape blocked (network egress, root-fs write, host-FS visibility, creds), covered by
`tests/unit/sandboxed-agent-runner.spec.ts` (the container tests skip when Docker is absent). The
engine still never spawns the agent itself.

**Slice 3 — the orchestrator (BUILT + proven end-to-end).**
`src/features/dev-console/services/dev-session-orchestrator.ts` (`DevSessionOrchestrator`) composes
the two red-team-hardened cores into one governed step: seed a sandbox scratch from the session
worktree → run the agent command in the locked-down container → extract its edits as a text-only
change set → `engine.applyChangeSet` into the governed worktree → return the reviewable diff. Commit
stays a SEPARATE, verify-gated, operator-approved step. Driven by `npm run dev:session agent-edit
<id> -- <cmd...>`. **Proven end-to-end against the real repo:** a sandboxed agent edited a real TS
file → applied to the worktree → the real `tsc` gate passed (with `--preserveSymlinks`, required
because the worktree's node_modules is a junction) → committed to a `dev-session/*` branch → **main
HEAD/tree provably untouched, clean teardown.** Covered by `tests/unit/dev-session-orchestrator.spec.ts`.

### 5. Phase 2 — the browser experience (Slice 4 BUILT)

`DevSessionManager` + super-admin broker routes (`POST /api/dev-console/sessions`, SSE
`/sessions/:id/stream`, `POST /sessions/:id/{commit,discard}`, `GET /sessions`) + the orb **Dev
panel**: a super-admin types a change, watches the **thought-chain stream live** (SSE), reviews the
**proposed diff**, and **Approves** (commit to the branch) or **Discards**. The instruction only ever
becomes the sandboxed agent's ARGUMENT (the command is built server-side from `mode`) — never a host
shell. The manager runs where the repo + docker live; the containerized controller (no `.git`) reports
the runtime **unavailable (503)** rather than pretend. Proven live: demo mode streams frames → applies
→ async typecheck → commit-to-branch, `main` untouched, owner-isolated.

**Trigger red-team (2026-07-05):** 4 agents, 10 findings, **NO host-escape / auth-bypass / cross-owner**
— the trust boundary holds. Fixed before ship: container **reaping** on timeout/abort/discard (`--name`
+ `docker kill`, an `AbortSignal`); a **SAFE egress default** — agent mode *refuses* to run unless
`OSHAL_DEV_AGENT_NETWORK` (a narrow provider-egress network) is explicitly configured, because open
egress + a creds mount + the seeded repo would be an exfil path; an **active-session cap** (429); a
**stale-session reaper**; and a **non-blocking async verify** (`verifyAsync`, `spawn`) + async seed so a
co-resident server isn't frozen by a multi-second `tsc`.

**RESIDUAL:** (a) enable a real LLM agent by setting `OSHAL_DEV_AGENT_NETWORK` to a narrow
provider-egress network (+ `OSHAL_DEV_AGENT_CREDS`/`IMAGE`); **demo mode proves the whole pipe with no
LLM/network today.** (b) the change-set snapshot/hash steps are still synchronous — the self-edit
runtime should run on a **sidecar node**, not co-resident with the tenant-serving API (the container
path already returns 503 there). (c) SSE reconnect replays the full frame buffer (super-admin nuisance
only, un-fixed).

**Why the isolation is load-bearing:** the hot-swap mount (`docker-compose.hotswap.yml`, tsx-watch
over mounted source) makes any edit to `src/**` on the deployed main checkout live *instantly* — so
generation-in-progress must never touch the live tree, and a commit must never reach main without the
human approval step.

### 4. Phase 3 — the lifeboat: recover the swarm (Proposed)

A node with access to the Docker host gains the recovery muscles — rebuild the image, restart the stack, bring it back green — from the sidecar's **standalone UI that survives the swarm going down** (the conversation can be driven from your phone while the host-resident node does the muscle). This is the capability that made "sidecar, not swarm bot" non-negotiable.

### 5. Traceability — ticket-as-session

Consistent with the ticket-based fabric: one **dev-session ticket** opens per chat session; every action inside (log read, edit, approve, apply, restart) appends to that ticket's trace over the mesh. Full traceability without forcing turn-by-turn into separate tickets.

### 6. The trust ladder — autonomy earned per risk-class, never wholesale

| Rung | You | The platform | Arrives |
|---|---|---|---|
| L0 · Manual | Edit in Cline / Claude Code | Hosts the result | Today |
| L1 · Copilot | Approve every diff | Proposes, explains, waits | Phase 2 |
| L2 · Scoped autonomy | Set the policy | Low-risk classes (docs, tests, personas) auto-apply behind evidence gates; core code stays gated | After L1 earns trust |
| L3 · Self-healing | Read the report | Detect → fix → prove → deploy, with auto-rollback | The end-state |

"Full autonomy on day one" is explicitly rejected: it trades the uncopyable claim (*proof-gated* self-development) for risk that isn't needed.

## Consequences

**Positive**
- Zero exposure by default: two independent OFF-by-default gates + operator-independence mean a stock enterprise deploy ships the code but not the capability.
- Debuggable by construction: a deterministic decision trace in logs, audit rows (allow + deny), and a caller-facing `/access` explanation.
- Reuses ~90% of existing rails (remote-node/A2A/mesh, tickets, audit, Jarvis, the operator-allowlist pattern) — Phase 1 adds one middleware, one route module, one shell script, and a test.
- The orb delivers the "Jarvis everywhere" win immediately and hot-swaps in with no rebuild.

**Negative / risks**
- Phases 2–3 grant root-grade host access to an agent loop. Mitigations are mandatory: worktree isolation, diff-preview + explicit approval, typecheck gate, branch-only apply, full audit, and (per ADR-040/070) a security review before any multi-tenant or always-on privileged runtime.
- The hot-swap mount means `main` edits are live immediately — the design must never write to the live tree without the human-in-the-loop apply step.
- TypeScript route changes require an image rebuild + api recreate to go live (only `src/pages` hot-swaps); Phase 1's backend endpoints are live after the next standard rebuild, while the orb is live on refresh.

**Debug / operate**
- Turn it on: set `OSHAL_DEV_CONSOLE_ENABLED=true` + your `OSHAL_SUPERADMIN_EMAILS`/`SUBS` in `.env`, recreate `oshal-api`.
- Diagnose access: as a super-admin, `GET /api/dev-console/access` returns exactly why you are/aren't in. Denials are in the logs and `access_audit_log` (`action='dev-console.denied'`, throttled to ≤1/caller/60s).

## Security review (2026-07-05)

A 5-agent adversarial red-team (bypass / fail-open / data-leak / framework-integration / completeness) probed the gate. **No bypass and no fail-open were found — the double-gate holds.** Six lower-severity findings were confirmed and resolved before ship:
- **[medium] deny-path audit write-amplification** (any authenticated caller could flood the deny path → unbounded audit writes / pool exhaustion). Fixed two ways: the router is now mounted **only when the capability is enabled** (a disabled deployment has no reachable surface at all), and deny-audits are **throttled to ≤1 per caller per 60s**.
- **[low ×3] `/access` disclosure** (revealed the console's existence + enable-state + env-var names to any authenticated user). Fixed: mount-gating returns 404 when disabled; `/access` returns a bare `{superAdmin:false}` to non-admins (full trace only to an actual super-admin).
- **[info ×2] platform-global health snapshot** (by-design for a platform-scoped super-admin; documented) and **`/access` not audited** (accepted: it is a benign, high-frequency self-status check the orb calls on every page load — auditing it would itself be noise + a write-amplifier).

Covered by `tests/unit/dev-console-superadmin.spec.ts` (10 tests, incl. the throttle).

### Security review (2026-07-05) — Phase 2 Dev Session Engine

A second 4-agent red-team (escape/touch-main · data-loss · gate-evasion · completeness) attacked the
isolation invariants and **reproduced two CRITICALs live**, which reshaped the design:
- **A worktree cwd is not a sandbox** — an unconfined agent process shares the main repo's git object
  DB + refs (it moved the shared `main` via `git update-ref`) and can write any absolute path. Fix:
  the engine **no longer runs the agent** (the `runAgent` method was removed); the agentic loop is
  deferred to a real OS sandbox (Slice 2). The engine governs only the deterministic, reviewed
  change-set path.
- **Teardown could delete the SHARED `node_modules`** — `git worktree remove --force` recursed through
  the junction when the unlink failed (a real dir left by `npm install`, a lingering lock, AV). Fix:
  teardown removes the junction, **proves it is gone (`lstat`) and refuses the destructive removal
  otherwise**, never swallows the error, and refuses if `node_modules` is a real directory. Proven
  live: both the normal and the attack case leave the shared `node_modules` intact.
- Also fixed: **realpath-aware `safeJoin`** (a symlinked worktree dir can't tunnel a write outside);
  **`.git`/`.githooks`/`node_modules` writes rejected** (can't neuter the commit hooks); **every method
  validates the session** (a poisoned `sessions.json` can't repoint at the live tree); **`commit`
  requires a passing `verify` for the exact tree**; larger diff buffer.

Covered by `tests/unit/dev-session-engine.spec.ts` (12 tests) + a live teardown-safety proof.
