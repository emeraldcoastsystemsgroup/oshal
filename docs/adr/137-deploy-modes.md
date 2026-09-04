# ADR-137 — Deploy modes: one named posture instead of a dozen independent switches

**Status:** Proposed — operator direction 2026-09-04, minimal implementation landed with this ADR.

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
