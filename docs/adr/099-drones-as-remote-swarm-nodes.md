# ADR-099: Drones are remote swarm nodes; Drone Ops is an extension, not core

**Status:** Accepted (2026-07-17 — operator decision)
**Extends:** [ADR-098](098-drone-ops-app.md) (phase 1, sim-first). Supersedes ADR-098's
"framework-resident indefinitely" posture.

## Context

Phase 1 (ADR-098) shipped Drone Ops framework-resident with one simulated drone living
in-process on the API. Reviewing it, the operator set two corrections that define the target
architecture:

1. **"Drone is not core functionality — it's an extension."** Drone Ops belongs in the
   oshal-applications store (ADR-085), installable/removable like brand-graphics, youtube-kids,
   and lora — not baked into the core image forever.
2. **"Each drone is like a remote node. I like it in the swarm because it's secure — drone-to-drone
   comms are by default secure."** A drone is not a peripheral the API polls; it is a **swarm
   participant**. Vehicle connectivity rides the swarm's existing authenticated rails, so
   drone↔controller and drone↔drone communication inherit the platform's security model instead
   of inventing a bespoke drone protocol.

This matches the platform identity (on-prem agent orchestration, ADR-078) and the smart-home
edge-agent aggregation model: the swarm already knows how to give a remote box an identity,
a heartbeat, an authenticated envelope, and an audit trail — the apply-operator desktop worker
is the live-proven precedent for a physical-world remote node.

## Decision

1. **Each drone = one swarm node.** A **drone node** is a companion process running at the
   vehicle (companion computer or ground station) that embeds a `DroneProvider` (sim today,
   MAVLink at the airframe later) and joins the swarm as a registered agent: own agentId,
   heartbeat (`oshal:runtime-agent:{agentId}`), commands and telemetry as authenticated swarm
   envelopes. In-LAN nodes use the Redis mesh; off-LAN nodes use the A2A/edge rail
   (headscale-http / service-secret) — the same two-tier split the platform already draws
   (in-swarm = mesh, external = A2A). **No raw drone links exposed to the network**: the only
   way to command a vehicle is through the swarm, under swarm auth, logged in
   `drone_command_log`.
2. **Drone-to-drone coordination goes through the mesh.** Fleet behaviors (mission splitting,
   deconfliction, fleet abort) are messages between drone nodes / the coordinator on the swarm
   channels — encrypted, authenticated, audited by default. This is the security property the
   operator chose the swarm for; do not build side channels between vehicles.
3. **The controller keeps the safety gate.** `DroneService` grows into the fleet plane
   (id → node), but geofence + mission validation and the draft → human-approve → execute
   doctrine (ADR-098) stay controller-side and apply per node. A drone node executes validated
   envelopes; it never originates flight on its own.
4. **A drone node is a device node, not an LLM node.** It runs no model and holds no vendor
   keys (mirrors the "swarm never calls an LLM / bot nodes own LLM execution" split — here the
   node owns *actuation* only). The `drone-operator` concierge stays a Form B reasoning bot on
   the api side, drafts-only.
5. **Drone Ops is packaged as a store extension** (ADR-085 rails: `ManifestBotRegistrar`,
   dynamic routes, `oshal-app-backup.sh` carve tooling). Sequencing (operator-aligned, cheap to
   reverse): rearchitect to the node model **in-repo first**, carve once the node shape is
   stable — carving the phase-1 in-process shape now would mean re-carving after the
   rearchitecture. Per the ADR-085 kernel rule (engines stay kernel, surfaces carve), the
   likely cut is: deterministic flight/validation slice → kernel-skill candidate; surface,
   concierge persona, routes, drone-node runtime → the package.

## Consequences

- Phase 2 in BACKLOG is re-pointed: the MAVLink adapter lands **inside the drone node**, and
  multi-drone = N registered nodes on one map, not N providers in one process. The sim provider
  doubles as the node's engine for hardware-free fleets (run 3 sim nodes → 3 drones).
- Adding a drone becomes "join a node to the swarm" (install companion runtime, mint identity,
  it heartbeats in) — the same operational story as adding any agent, which is the product
  thesis working in our favor.
- The A2A/edge rail gains its first non-desktop device consumer; anything unproven there gets
  proven here before hardware flies (sim nodes first, always).
- ADR-098's per-command geofence gate and audit trail are unchanged — they simply move from
  guarding one in-process provider to guarding a fleet of nodes.
