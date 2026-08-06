# ADR-102: Sat-Ops — satellites are swarm nodes; attitude control is sim-proven before anything else

**Status:** Accepted (2026-07-18 — operator-committed 30-night campaign). As-built same day: **W1** RK4 + NASA-42 node runtime; **W2** MEKF / magnetorquer desat / SGP4 passes / mode manager, LIVE-PROVEN against the 42 referee (5 missions, final arc PASS); **W3** `?app=sat-ops` fleet plane (3D orbit console, TLE catalog + tracks, conjunction screening, approve-gated command console, sat-operator drafting concierge); **W4** scored evidence campaign — 200 randomized closed-loop runs, 100% pass (`docs/evidence/sat-ops-adcs-campaign-2026-07-18.md`). Deploy of W2+ controller code rides the next image rebuild; sat nodes are host-side.
**Template:** [ADR-098](098-drone-ops-app.md) / [ADR-099](099-drones-as-remote-swarm-nodes.md)
(drone-ops proved this exact shape: device node in the swarm, sim-first, human-approval rail,
independent-simulator evidence campaign).

## Context

The operator committed (2026-07-17) to a 30-night campaign (~4 h/night, midnight–4 AM CT) to
build **sat-ops**: satellite attitude control (ADCS) as an OSHAL application. The origin was a
"you can't build satellite control" challenge, answered same-day with a working quaternion-PD
ADCS demo and a live 3D console. The campaign goal is the *credible* version of that demo:
**production-grade claims backed by evidence-scored campaigns against an independent
simulator**, exactly how drone-ops was proven against ArduPilot SITL before any hardware talk.

Drone-ops (ADR-098/099) already settled the architectural questions this domain re-raises:
a physical-world vehicle is a **device node in the swarm** (own identity, heartbeat,
authenticated envelopes, audit log), never a peripheral behind a bespoke protocol; commands
follow a draft → human-approve → execute doctrine; the sim engine is a first-class provider so
fleets exist hardware-free; the app carves to the store only after the shape is stable.

What is genuinely new in sat-ops: the control problem itself (rigid-body attitude dynamics,
reaction-wheel momentum management, estimation) and the independent referee (NASA's **42**
spacecraft simulator instead of ArduPilot SITL).

## Decision

1. **Each satellite = one swarm node** (ADR-099 §1 applied verbatim). A **sat node** is a
   process that embeds a `SatSimAdapter` (simulator today; a flight-software bridge is far
   out of scope) and joins the swarm as a registered agent with its own agentId + heartbeat.
   It is a **device node, not an LLM node**: it runs no model, holds no vendor keys, and owns
   actuation only. In-LAN nodes ride the Redis mesh; remote nodes ride the A2A/edge rail.
2. **Two simulators behind one contract.** All control code talks to the `SatSimAdapter`
   interface ([src/features/sat-ops/](../../src/features/sat-ops/)):
   - **In-house RK4 gyrostat propagator** — quaternion kinematics + Euler rigid-body dynamics
     with a 3-axis reaction-wheel cluster (torque + momentum saturation), integrated with
     fixed-step RK4. This is the **always-available noop-sim sibling**: zero external
     dependencies, deterministic, runs in unit tests and on any dev box.
   - **NASA 42 in a container** — the independent high-fidelity referee (flexible dynamics,
     environment models, sensor models we did not write). The adapter speaks 42's socket IPC.
     Scoring runs against 42; the in-house propagator can never grade its own homework.
3. **Commands never leave the sim.** The drafts-never-fly gate from ADR-098 becomes
   *commands-never-leave-sim*: there is no path from this codebase to a radio, ground station,
   or live spacecraft, and none is planned inside this campaign. The gate is structural (no
   transport exists), not a config flag.
4. **Evidence doctrine (W4):** 200+ randomized scored runs — settle time, pointing stability,
   wheel-saturation duty, fault recovery — with at least 2 sat nodes heartbeating live in the
   swarm, mirroring the drone-ops evidence campaign. No "production-grade" claim before that
   ledger exists.
5. **30-night scope** (every 7th night = verify/catch-up, no new scope):
   - **W1 foundations:** this ADR; sim-adapter contract + RK4 propagator + quaternion-PD
     controller (shipped night 1); NASA-42 container adapter; sat-node runtime skeleton.
   - **W2 realism:** EKF attitude estimation from noisy gyro/star-tracker models, wheel
     momentum + magnetorquer desaturation, SGP4 pass windows (satellite.js),
     SAFE/DETUMBLE/POINT/SLEW/DESAT mode manager.
   - **W3 surface:** `?app=sat-ops` cockpit fleet plane (adapting the demo's 3D renderer),
     draft → approve → execute rail per node.
   - **W4 evidence:** the scored campaign of #4.
6. **Packaging:** store extension **last** (ADR-085 mechanics, same sequencing rationale as
   ADR-099 §5 — carving before the node shape is stable means re-carving). Manifest
   `suite: ai-engineering`. cFS integration + CCSDS space-packet framing are **stretch/backlog,
   explicitly NOT in the 30 nights**.

## Consequences

- Night-1 code is controller + physics only — no routes, no manifest, no bot registration —
  so nothing mounts or auto-loads until the node runtime exists; the slice is inert until
  imported. Estimation is deliberately absent in W1: the controller reads true sim state, and
  the honest label for that is "control demo", not "flight software", until W2's EKF lands.
- The 42 adapter gives the platform its second containerized non-LLM engine (after SITL),
  reinforcing the "engine is just a URL/process behind an adapter" pattern (ADR-045 said the
  same for graph engines).
- The A2A/edge rail gains a second device-node consumer; anything the drone nodes didn't
  exercise gets exercised here — still entirely in sim.
- A future real-vehicle path (ground-station integration, CCSDS uplink) would be its own ADR
  with its own safety doctrine; nothing in this campaign pre-commits to it.

## Post-acceptance covariance verification (2026-08-05)

NASA 42's calibrated `direct` and `conjugate` quaternion interpretations now share explicit,
pure adapter boundaries: first compose the table-provided tracker mount out of the complete
noisy `stQn` sample, then interpret that complete sample. Conjugation is never applied only to
the nominal attitude. A deterministic 240-fix replay in
`tests/unit/sat-ops-nasa42-convention.spec.ts` proves that both encodings place the tracker
2/2/20-arcsec covariance on the same body axes (including off-diagonal terms) and produce the
same MEKF accept/reject/reinitialize decisions. This is local synthetic evidence; a captured or
live NASA 42 run forced onto the conjugate branch remains an external referee gate.
