# ADR-093: Packaged-app runtime placement — where installed apps' bots and infra run (D1)

**Status:** Accepted (operator decision 2026-07-13, via the decision slate)
**Context:** ADR-085 (app packages), ADR-090 (skills — O5 widens this decision), the
swarm-store migration plan's Wave-0 gap **D1**.

## Context

A store-installed app may need more than routes and migrations: a dedicated bot (LM's codex
bots, a trading analyst) or even a package-declared **server** (ADR-090 §7 — a database skill needs
a database instance). Today every bot container is hand-declared in
`docker-compose.oshal-local.yml`; an install cannot add one. Three candidate models were on the
table, with research for the most ambitious one in
[docs/research/generic-node-pool-hot-loading-architecture.md](../research/generic-node-pool-hot-loading-architecture.md).

The operator's constraint, stated verbatim with the decision: this must not be
*"a big framework change"*. The decision therefore commits to the smallest mechanism per bot
class and explicitly does NOT green-light the pool build.

## Decision — three tiers, smallest mechanism that fits

1. **Reason-only bots → inline concierge (exists today, zero new framework).**
   Registered `container: 'oshal-api'`, reached via `POST /chat` / provider-runtime — the
   proven pattern (capture-specialist, codex-packer). Packages declare
   these bots in the manifest exactly as now; the loader registers them; nothing new ships.

2. **Heavy bots (shell-out / device / own store) → package-shipped compose fragment (INTERIM).**
   The package carries `compose.fragment.yml` declaring its bot service(s) on the standard
   `any-bot` image + env anchors. `oshal-app install` surfaces it; **applying it is an
   explicit operator step** (documented command, never automatic) because a compose fragment
   is container-level trust. Acceptable while every installable app is first-party and installs
   are operator-gated (which they are). This is scaffolding, not architecture — each fragment
   is debt the target tier retires.

3. **Generic node pool → TARGET, not a commitment.**
   Pre-provisioned generic bot-node containers that hot-load a persona/config at dispatch
   (the research doc). It is the right end-state for a real store (installs never touch
   compose, third-party never authors container config), and the interim fragment format will
   be designed so a fragment's declaration maps 1:1 onto a future pool claim. **Building the
   pool requires its own go/no-go from the operator** — this ADR does not authorize it.

**Scope (per ADR-090 O5, decided the same day):** these tiers govern ALL package-declared
runtime — bot containers **and** skill-declared services (a skill-declared database server ships as a
tier-2 fragment today, a pool/provisioner claim later). No separate mechanism for skill infra.

**Trust rule:** tier-2 fragments are **first-party/operator-reviewed only**. A third-party
package requesting tier-2 runtime is an install-time refusal until the pool (or an equivalent
sandboxed provisioner) exists — same posture as ADR-090's trust-scoped credential default.

## Consequences

- **Positive:** Wave 1 unblocks immediately with zero new framework; the store's answer to
  "my app needs a bot" is documented instead of folklore; the pool stays a target with a
  defined migration path (fragment → claim) rather than a prerequisite.
- **Cost:** compose fragments accumulate as known debt (one per heavy-bot app) until the pool
  lands; applying a fragment is a manual operator step, so heavy-bot installs are not
  one-command.
- **Risk accepted:** if the pool is never built, the fragment tier hardens into the permanent
  answer — acceptable for a self-hosted/first-party fleet, not for a public store; the public
  track already has harder gates (ADR-090 O8).
