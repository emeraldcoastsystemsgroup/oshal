# ADR-098: Drone Ops app — single-drone automation control, sim-first

**Status:** Accepted (2026-07-17) — extended same day by
[ADR-099](099-drones-as-remote-swarm-nodes.md) (operator decision: Drone Ops is an extension, and
each drone is a remote swarm node; the safety doctrine below is unchanged).
**Phase 1 shipped:** feature slice `src/features/drone/`, routes `/api/drone`, surface `?app=drone`,
`drone-operator` concierge, unit suite `tests/unit/drone-sim.spec.ts`.

## Context

The operator wants a drone coordination system, starting with simple single-drone automation
control. Constraints that shaped the design:

- **No hardware on the bench.** Nothing here can be proven against a physical drone today, and a
  half-tested MAVLink stack would violate the no-mock-deliverables rule in spirit: it would *look*
  real and be unverifiable. The platform already has a doctrine for this shape — providers/harnesses
  are interfaces with sibling implementations (ADR-033), and the `noop` harness proves the value of
  a deterministic engine for development.
- **Flight is not LLM work.** ADR-036 splits cheap I/O from reasoning. Actuating an aircraft is
  deterministic control code; the LLM's job is turning intent ("fly a 100 m box at 40 m") into a
  *plan*. An LLM in the actuation loop would be both unsafe and unaccountable.
- **The platform has an approval doctrine** (Content Studio: nothing posts without approval;
  connector write-actions: approval-gated) that maps directly onto flight.

## Decision

1. **Engine-agnostic `DroneProvider` interface** (`src/features/drone/services/drone-provider.ts`):
   arm/disarm/takeoff/goto/mission/abort/land/RTL + telemetry + events. Phase 1 ships ONE
   implementation: `SimDroneProvider`, a deterministic kinematic simulator (lazy ≤1s-substep time
   integration, injectable clock, fixed climb/descent rates, per-state battery drain, battery
   failsafes: low → RTL, critical → land in place). A MAVLink/SITL adapter is a **sibling
   implementation behind the same interface** (roadmap, see BACKLOG) — not a rewrite.
2. **Deterministic safety gate outside the engine.** `DroneService` validates EVERY command against
   a geofence cylinder (default: 500 m radius, 2–120 m AGL — FAA Part 107 ceiling; env-tunable via
   `DRONE_FENCE_*`, home via `DRONE_HOME_LAT/LON`) before the provider sees it. The same gate will
   guard real hardware.
3. **Draft → approve → execute.** The `drone-operator` bot (Form B inline concierge,
   `b0100000-…-01`, operator+swarm scoped per ADR-087) only ever DRAFTS missions: strict JSON
   envelope `{say, mission|null}`, normalized (`normalizeMissionDraft`), geofence-validated, and
   persisted per-user as `status='draft'`. Nothing flies until a human hits
   `POST /api/drone/missions/:id/execute`, which **re-validates the stored plan against the fence
   at execution time**. Executing is the approval — mirroring the connector write-action rail.
4. **Audit.** Every actuating command (accepted or rejected) lands in `drone_command_log` under the
   caller's sub. Missions + conversations are per-user (`drone_missions`, ConciergeStore prefix
   `drone`); the drone itself is deployment-level in phase 1.
5. **Surface is a view** (ADR-036): `?app=drone` renders a canvas ENU map (fence, range rings,
   trail, waypoints), telemetry, flight controls, a click-to-plan mission builder, and the
   operator chat. All state comes from `/api/drone` polls.

## Consequences

- The whole app is exercisable end-to-end (and unit-tested, 15 specs) with zero hardware, and the
  hardware step later is scoped to one adapter file + an env switch.
- The sim is honest about what it is: `provider: 'sim'` is surfaced in `/api/drone/config` and on
  the surface pill. Docs must not describe hardware flight as built (as-built rule).
- Multi-drone coordination (the actual goal) gets a clean seam: `DroneService` is the single place
  that grows a fleet map; the provider interface already isolates per-vehicle state. Phase 2 scope
  + done-when live in BACKLOG ("Drone Ops phase 2").
- One shared deployment-level drone means concurrent users share the vehicle in phase 1. Fine for
  an operator tool; per-user/per-tenant vehicles are a phase-2 concern alongside multi-drone.
- Jarvis cannot discover or call the drone-operator (accessRoles) — flight planning stays an
  explicit, operator-driven surface until there's a reason to widen it.
