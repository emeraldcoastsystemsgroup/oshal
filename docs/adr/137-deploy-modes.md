# ADR-137 — Deploy modes: one named posture instead of a dozen independent switches

**Status:** Proposed — operator direction 2026-09-04, minimal implementation landed with this ADR.
Amendment A (credential posture per mode) accepted and built 2026-09-04.
Amendment B (the operator's own turns fall to the portal fallback after their endpoint is
exhausted) accepted and built 2026-09-22.

**Date:** 2026-09-04

**Related:** [ADR-013](013-headscale-self-hosted-overlay-network.md) (overlay network),
[ADR-117](117-local-auth-invited-users.md) (LOCAL_AUTH), [ADR-127](127-demo-mode-cli-brain-and-user-provider-preference.md)
(DEMO_MODE), [ADR-135](135-print-to-swarm-and-print-to-rag.md) (edge nodes and print intake),
[connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md).

---

## Context

The operator's framing: *"I may want to run it as a local swarm behind a firewall, and at the same
time a different configuration may want to run it as a multi-tenant application, someone else local
demo mode on a home network. So we have to figure out this deploy mode."*

**Every capability those three shapes need already exists.** Open auth for a demo, invited-user login
for a household, real OIDC and tenancy for a hosted deployment, device-bound node tokens for remote
machines, a self-hosted overlay for off-LAN reachability. None of this ADR is about adding
mechanisms.

The problem is that a deployer composes those shapes by setting roughly a dozen unrelated
environment variables, **the dangerous combinations fail open, and nothing checks the composition.**
Four verified examples, all from this repo:

| Switch | Behaviour | Why the composition matters |
|---|---|---|
| `MOCK_OIDC=true` | `requiresAuth` becomes a pass-through | Correct for a laptop demo. On an internet-facing box it makes every route publicly callable |
| `REMOTE_CLIENT_REQUIRE_NODE_TOKEN` | **ships `false`** | The retired swarm-wide shared secret stays live — one leaked copy reaches every desktop. Deliberate for migration, dangerous as a resting state |
| Headscale container stopped | `Test-ShouldGoOffLan` returns false | `-OffLan` silently emits a LAN-only join code instead of failing |
| `OSHAL_CSP_REPORT_ONLY` | wins over the enforce flag | A box can believe it enforces CSP while reporting only |

Each switch is individually defensible. The composition is what is safe or unsafe, and today the
only thing that reads the composition is a human.

There is one precedent worth generalizing rather than replacing: `local-auth-routes.ts` already
**refuses to boot** when `LOCAL_AUTH` and `MOCK_OIDC` are both set — *"throw instead of silently
degrading to open auth."* That is exactly the right instinct, applied to exactly one pair.

---

## Decision

### D1 — `OSHAL_DEPLOY_MODE` names a posture; it does not invent one

Four modes, matching the shapes the operator named:

| Mode | Shape | Auth | Network | Remote nodes |
|---|---|---|---|---|
| `demo` | One machine, one person, a laptop | Open (`MOCK_OIDC`) is acceptable | Loopback | Refused |
| `home` | A household or small team behind a firewall | Invited users (`LOCAL_AUTH`) | LAN | Device-bound tokens required |
| `connected` | `home` plus machines on other networks | Invited users or OIDC | LAN + self-hosted overlay | Required, and the overlay must be **running** |
| `tenant` | Multi-tenant hosted | Real OIDC required | Public ingress | Required |

A mode is a **named composition of switches that already exist**, plus the assertions that make the
composition coherent. It adds no new runtime capability, and it is not a feature flag system.

### D2 — A mode does three things, and only three

1. **Supplies defaults** for the posture switches, so the common case needs one variable instead of
   twelve.
2. **Refuses to boot on a contradiction** — generalizing the `LOCAL_AUTH`/`MOCK_OIDC` precedent.
   `MOCK_OIDC` in `tenant` mode is not a warning; it is a failed boot.
3. **States the resolved posture at boot**, so an operator can read what they are actually running
   instead of deducing it from twelve variables and a container's uptime.

An explicit environment variable still wins as a *value*. What it cannot do is produce a combination
the mode declares incoherent — that throws, with the variable and the mode named.

### D3 — Unset means "today", loudly — never a silent new default

`OSHAL_DEPLOY_MODE` unset behaves **exactly as the deployment does now**, and logs one warning naming
the mode that matches the detected posture. Existing deployments cannot break from adopting this
ADR, because unset changes nothing.

This is deliberate and it is the whole reason the change is safe to land immediately. Choosing a
default in this release would silently re-posture every existing box — which is the class of failure
the ADR exists to prevent. A later release can flip the default once deployments carry the variable.

### D4 — The mode can tighten; loosening is explicit and logged

Where a mode's default is stricter than the ambient setting, the mode wins. Where an operator
explicitly sets a variable that *loosens* a mode's posture, the value applies **and is logged as a
deviation**, unless the mode declares it forbidden, in which case the boot fails. Silent loosening
is the failure this prevents; deliberate loosening is a legitimate operator choice that should
appear in a log line rather than in nobody's memory.

### D5 — Resolution is a pure function, and it is where the guards live

`resolveDeployPosture(env)` takes an environment and returns `{ mode, posture, deviations,
violations }` with no I/O. Boot calls it, throws on violations, and logs the rest. The consequence
is that every mode rule is testable as a table — the composition is the thing most likely to be got
wrong, so it is the thing under test, without a container or a network.

### D6 — Feature reach follows the mode, and features ask rather than re-derive

A feature that behaves differently by posture — the printer's bind address, whether off-LAN join is
offered, whether a remote node may enrol — reads the resolved posture instead of re-deriving intent
from raw variables. Re-derivation is how two subsystems end up disagreeing about what deployment
they are in.

For [ADR-135](135-print-to-swarm-and-print-to-rag.md) specifically: `demo` binds the printer to
loopback and refuses the forwarder; `home` allows a LAN printer and local intake; `connected` is the
first mode where an off-LAN edge printer is coherent, and it is exactly the mode that requires the
overlay to be running.

---

## Consequences

**Good**

- One variable expresses intent. The dozen switches remain, but a correct composition stops being an
  act of memory.
- The dangerous combinations fail at boot instead of at exploitation time. `MOCK_OIDC` on a hosted
  box is currently a silent open door; it becomes a refusal that names itself.
- "Which deployment is this?" becomes readable — from a log line, not an audit.
- Nothing breaks on adoption, because unset is today's behaviour.

**Costs / risks**

- **A mode is a promise, and an incomplete one is worse than none.** If `tenant` asserts five things
  and a sixth matters, an operator may believe the mode covered it. The mitigation is that the
  posture object is explicit about what it asserts, and that the boot line prints the assertions
  rather than a reassuring name.
- Adding a mode-aware feature adds a place to be inconsistent. D6 exists to bound that: read the
  posture, do not re-derive it.
- The modes will not fit every deployment. `connected` and `tenant` in particular are shapes the
  project has not yet run at scale, so their assertion sets should be expected to grow.

---

## What is built with this ADR

The minimal, non-breaking core: `src/shared/deploy-mode/` — the pure resolver, the mode table, the
violation rules — and a guard exercising the whole table. Boot-time enforcement and the per-feature
reads (D6) follow once the mode table has survived contact with a real second deployment.

Deliberately **not** built here: any change to what an unset deployment does.

---

## Amendment A — credential posture per mode (operator, 2026-09-04)

The operator restated the modes along a second axis — **where the AI credentials come from** —
after the career engine spent 25 days "looking for something that isn't there": its brokered-only
credential wall had no carve for the deployment's own logins, so AI scoring silently died on a box
where every other bot ran fine on the mounted `~/.codex`.

| Posture | Who it serves | AI credentials | Built |
|---|---|---|---|
| **demo / dev / test** (`demo`, and any posture with `DEMO_MODE`) | one person's own machines | The **portal fallback**: the deployment's own vendor logins — pushed with the build from the computer that built it, or pushed from a satellite. Lent only under ADR-127's two gates: `DEMO_MODE` truthy **and** the exact `OSHAL_OPERATOR_SUBS` subject. | yes |
| **SaaS / multi-user** (`tenant`, and every non-demo posture) | many people | **Key-based, per user**: credentials brokered from the caller's own connector rows, under the names each engine reads. Vendor CLI logins are never lent, and a pushed login is refused (409). | yes |
| **codebase** | a developer swarm | as above, and the swarm may modify its own code through the developer rails | recorded, not built — BACKLOG |
| **codeless** | an install-from-Docker swarm | as above; the swarm may not write its own code and files defects to a tracker instead | recorded, not built — BACKLOG |

`codebase` / `codeless` is a **development** axis, orthogonal to network reach; it is recorded here
so the next reader does not mint a fifth network mode for it.

**What this amendment ships**

1. **Store, career-hunter 1.12.4** — the engine child inherits the mounted vendor logins under the
   two gates (`operatorPortalFallback`), and the per-user keys the dispatch brokers now reach the
   engine under the names it reads (`OSHAL_CRED_ANTHROPIC` → `ANTHROPIC_API_KEY`) — the tenant
   path that had been a dead end.
2. **Core, `POST /api/claude-code/auth/import`** — adopts the `.credentials.json` a satellite's
   `claude auth login` wrote into the controller's mounted login path under the same two gates; the
   SEC-05 409 stands everywhere else, and a read-only mount answers its own 409 naming
   `CLAUDE_AUTH_MOUNT_MODE=rw`. Codex already had this shape: operator platform promotion on
   `POST /api/openai-codex/oauth/import` writes the live `~/.codex/auth.json`.
3. **`@oshal/chat`** — "Log in + push" and "Push to swarm" on the Codex and Claude rows. The vendor
   CLI runs its own login and listens on its own localhost redirect on the satellite (the VS Code
   pattern — the vendor's OAuth is never brokered); the node notices the file the CLI writes and
   pushes it under the user's verified OIDC session, refusing plain http to a public host.

Guards: store `career-no-sync-api.test.mjs` (wall vs carve, brokered-key mapping); core
`claude-code-demo-login-adoption.spec.ts` (real router + service: both gates, atomic 0600 write,
read-only 409, wrong-shape 400), `claude-code-credential-distribution-boundary.spec.ts` (the carve
cannot widen past both gates), `node-login-push.spec.ts` (what may leave the satellite, and where).

---

## Amendment B — the operator's own turns may fall to the portal fallback after their endpoint is exhausted (operator, 2026-09-22)

Amendment A lends the portal's own vendor logins to the operator under two gates. It said nothing
about a turn the operator had pointed at **his own** endpoint (Settings → My default brain → "My own
endpoint"). The platform's standing rule for such an explicit BYO endpoint was *never rotate it*
(`reportResolvedLlmFailure`): the endpoint is the caller's billing and privacy boundary. On
2026-09-21 that rule cost the operator two turns — his Gemini Pro endpoint (a GCP backend with a
provider-side spend cap and a short-window ceiling) answered HTTP 503 "This model is currently
experiencing high demand" twice, once through Jarvis and once through the inline class-tutor path —
and each time the whole turn was lost with no retry of any kind.

The operator's words, in order: *"fix the retry but use the fallback - no big deal, we have an
immediate fallback. I like Google, it's fast, but we do have a fallback. Can we keep a HOT fallback
as well - this portal has Codex and Claude Code."* Then: *"Configurable. Codex followed by Claude
Code, if either is available, by default - but this is configurable, there is literally an API
endpoint, it's already been set."*

**Two rules now stand side by side, and both are written at the refusal in `free-tier-rotation.ts`.**

1. **The same-endpoint retry (2026-09-21).** An explicitly chosen endpoint (`resolutionSource:
   'explicit'`, and only that) that answers a capacity wall — 429, 402, 503 with a high-demand /
   overloaded / service-unavailable body — is replayed against *itself*: same URL, same key, same
   account. That is not a rotation and crosses no boundary. It wraps the **model call**
   (`SameEndpointRetryProvider`, inside the orchestrator's turn), so the user message is saved once
   and the error is broadcast once; `OSHAL_BYO_RETRY_*` bound it, `0` switches it off. A threaded
   free-tier, platform or operator-key lane gets one attempt and rotates, as before. A 400, 401,
   403, 404, bare 500 or completed-but-empty answer is never retried.

2. **The operator's hot fallback (2026-09-22).** For the **operator's own** explicit turns, and only
   those, "never rotate a BYO turn" is superseded: once the retry is exhausted the turn falls
   **once** through the portal's **configured** fallback chain. The gates are exactly Amendment A's:
   `DEMO_MODE` truthy **and** the caller's sub in `OSHAL_OPERATOR_SUBS` (`cliBrainAvailable`). For
   every non-operator caller nothing changes — their endpoint is never rotated and the portal's
   logins are never lent to them.

**The chain is the record [ADR-162](162-a-bots-brain-is-layered-records.md) already resolves the
brain from.** The bot's own switch row's `fallback_order` if it carries one, else the fleet-default
row's (migration 148), else `OSHAL_PROVIDER_FALLBACK_ORDER`, most specific first; only when every
record is silent does the default `openai-codex, claude-code` apply. It is changed with the endpoint
that already exists, and takes effect on the next turn with no restart:

```
PUT /api/agents/provider-switch/fleet-default
{"providerId":"<the fleet primary>","fallbackOrder":["openai-codex","claude-code"]}
```

Measured on the operator box on 2026-09-22, the fleet-default row reads `provider_id=claude-code`,
`fallback_order={gemini,openrouter}` — so today his hot fallback walks Gemini then OpenRouter, which
is what he configured; the default applies only where no record carries a chain.

**Readiness is what makes a rung safe to take.** Each rung is taken only when the probe
(`fallback-rail-readiness.ts`) says it is ready right now: a CLI login rung has its login file
present and unexpired and its bot node answering; a hosted rung has its vendor key present and is
not sitting out a failure cooldown. A rung that is not ready is skipped with its reason logged and
never spent on. That gating is what makes re-admitting `claude-code` to an automatic chain safe
against the 2026-08-13 concern that removed it ([ADR-128](128-codex-fleet-default.md) Amendment 1,
"silent spend on a dying account"): a dying account's login has lapsed, reads not-ready, and is
skipped. The 2026-09-22 decision supersedes that removal **for this configurable, readiness-gated
fallback only**; `DEMO_CLI_ORDER` (the chat/user rung) is not changed by it.

**Where each rung can run.** A CLI login rung serves only a turn on a bot node — re-dispatched with
the rung stamped as the authoritative provider, where the node's own SEC-05 preflight re-enforces
the same carve; nothing about that preflight is weakened. A controller-inline turn cannot ride a
CLI, so for it only a hosted rung with an in-process lane (`openai-compat-lanes`) can serve, riding
as the operator-key connection; the switch happens at the model call inside the same turn.

**Never silent.** One pass through the chain; each ready rung once; no fallback-of-the-fallback; no
fallback on a non-retryable failure. Every fallback turn carries the `brainFallback` marker
(provider used, rung, chain source, the failed endpoint's host and model, the attempts, the reason —
never a key), the cockpit chat panel and the Jarvis surface render it as "answered by X; Y was
unavailable after N attempts", and the switch is logged at WARN. When the fallback applied and no
rung could answer, the user gets a 503 `BYO_FALLBACK_NOT_READY` whose text names the endpoint, the
attempts and every rung's reason. The Settings → My default brain card shows the chain, its source,
and each rung's readiness, with the PUT that changes the order.

Guards: `tests/unit/byo-same-endpoint-retry.spec.ts` (the replay wraps the provider call across a
loopback endpoint and the real cockpit router; explicit-only; 503; 0 = off; one saved message, one
broadcast) and `tests/unit/byo-hot-fallback.spec.ts` (operator-only, readiness-gated, configured
chain honoured and re-ordered by the real PUT with no restart, the marker, the WARN line, the
not-ready error, the node re-dispatch), both registered on the AI Test Lab `byo-hot-fallback`
scenario.
