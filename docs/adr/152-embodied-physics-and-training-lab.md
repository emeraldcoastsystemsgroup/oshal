# ADR-152 — Embodied physics and training lab: our parts, in a 3-D world, under physics, without the hardware

**Status:** Proposed, 2026-09-13. Extends [ADR-151](./151-eyes-and-hands-embodied-swarm.md) (eyes and
hands; "sim first" accepted). Depends on the two hardware designs
([mobile manipulator](../architecture/embodied-mobile-manipulator-hardware.md),
[recon drone](../architecture/embodied-recon-drone-hardware.md)), the `aero-lab` propeller work and the
`scan-to-print` STL rail.

## Context

The operator's ask, verbatim in spirit: *we need a virtual environment with our specs working in a 3-D
world — we have these parts and we have a physics — that can help us model without the actual hardware,
so we can train the arms and the drones.*

What exists today (store package `embodied` 0.4.0):

- a deterministic 3-D world: a hidden box scene, a voxel occupancy map built from simulated LiDAR and
  depth pictures, discovery of surfaces and objects, scan-to-map registration, a six-axis arm with
  forward and inverse kinematics, a rolling base with a stability budget, a kinematic drone with a
  believed and a true pose;
- the rails: plans drafted against the discovered world, rehearsed on a clone, executed behind a
  confirm, every kinetic step re-validated against the map, a command log, command authority;
- the parts, as numbers: masses, reach, tip budget, sensor placements, propulsion sizing, printable
  geometry — in the two hardware documents, not yet as a model a physics engine can load.

What it is not: a physics engine. Nothing has inertia. The arm moves kinematically between joint
targets; the drone's autopilot flies a belief to a point; contact is a rule ("rests on the highest
top beneath the tool"), not a force. That is exactly right for proving rails and guards, and exactly
wrong for training a controller or a grasp.

Training needs three things the current engine cannot give: rigid-body dynamics with contact
(an arm that can miss, push, drop, tip), thousands of episodes per hour, and sensor emulation from
the actual geometry of the parts we intend to print.

## Decision

**D1 — One parts model, three consumers.** The parametric specs (the two hardware docs, aero-lab's
propeller curves, scan-to-print's STL geometry) become one machine-readable parts model in the
`embodied` package: masses and inertias, joint limits and torques, motor thrust and torque curves,
sensor poses and fields of view, mesh files. The STL printer reads it to print; the physics lab reads
it to simulate; the kinematic sim reads it for its constants. A number lives in one place.

**D2 — MuJoCo in an engine container.** The physics lab is a Python engine container in the
`embodied` package, following the `aero-lab` precedent (its aerosim engine already ships as a
container on the deployed box). MuJoCo (Apache-2.0) simulates the kitchen, the printed drone and the
arm from MJCF generated from the parts model; Gymnasium wraps the tasks; MJX is the optional GPU
path when episodes per hour matter more than a laptop can give. Sensors are emulated in the engine:
LiDAR by batched ray casts, depth by the renderer, IMU and optical flow with noise, rangers as rays.

**D3 — The TypeScript engine stays the authority.** Rails, guards, the discovered map, registration,
planners and the command log do not move into Python. The physics container is a *node*: it speaks
the same primitives (drive, lift, move arm, grasp, take off, go to, scan) and streams the same
sensor frames over the same node rail a real drone or arm will use (ADR-098/099). `WorldSim` gains a
physics backend behind an interface — `kinematic` (today) or `physics` (the container) — and every
guard runs unchanged on either. Sim-to-real is a change of endpoint, not of code.

**D4 — Training lane, fail-closed.** Policies are trained in the container on Gymnasium tasks with
seeded determinism and evaluated, before anything else, in the kinematic sim against the same
rehearsal rails a human's plan gets. A policy that passes becomes a *provider* (ADR-151 Q5 option B
becomes reachable): it proposes actions; the confirm rail, the tip budget, the map guards and the
e-stop still own whether they happen. No policy ever bypasses a guard, in sim or on hardware.

**D5 — First tasks, in this order.** (1) Drone position hold and one-leg flight under the measured
drift model and a disturbance model, on the recon-mini airframe: the fastest path to a flying part.
(2) Frontier exploration as a policy, scored against the deterministic frontier planner it must beat.
(3) Arm reach-and-grasp on discovered objects, with the taught pick-and-place as the baseline it must
beat. (4) The fridge door pull with the tip budget as a hard constraint in the reward. Each task
ships with its deterministic baseline, so a learned policy is always compared to something that
already works.

## Options considered

| Option | For | Against |
|---|---|---|
| Extend the TypeScript engine into a physics engine | one language, deterministic, no container | months to make contact and dynamics credible; no training ecosystem; reinvents MuJoCo badly |
| **MuJoCo + Gymnasium in a container (chosen)** | the standard for robot learning; fast, accurate contacts; MJCF from code; MJX for GPU batches; Apache-2.0 | a Python container to maintain; one more engine on the box (aero-lab already set the precedent) |
| PyBullet | easy, free | stagnant, weaker contacts, slower |
| Isaac Sim / Isaac Lab | photoreal, massive GPU parallelism | NVIDIA GPU required, heavy, licence friction, oversize for a kitchen |
| Genesis / other new engines | promising | unproven here; revisit in a year |
| Webots / Gazebo | full robot suites | GUI- and ROS-centred; the swarm is the orchestrator, not ROS |

## Consequences

- **Positive.** The parts we print, the physics we train in, and the numbers the kinematic sim
  guards with come from one model. Training does not wait for hardware; hardware, when it comes,
  plugs into the same rail the container used. Learned behaviour is gated by the same rails as a
  human's plan.
- **Negative.** A Python container joins the package (install, health, version pinning — aero-lab's
  recipe). Training costs compute; CPU MuJoCo gives thousands of steps per second per environment,
  GPU is optional and a later decision. Physics fidelity of printed parts is only as good as the
  measured masses and the propeller curves — weigh at assembly, measure at the bench.
- **Deferred.** Photoreal rendering for vision policies; multi-drone and multi-arm coordination;
  learned perception (discovery stays geometric until labels from pictures land, BACKLOG B11).

## Open decisions for the operator (cost / benefit)

| # | Decision | Option A | Option B | Recommendation |
|---|---|---|---|---|
| Q1 | Training compute | **CPU MuJoCo on the box.** *Gain:* nothing to buy; enough for the drone tasks. *Cost:* hours per policy. | GPU + MJX. *Gain:* minutes per policy. *Cost:* a GPU box or cloud spend. | A now; B when the arm tasks start |
| Q2 | First learned task | **Drone hover + one leg** (class 1, flies the printed part soonest). | Arm grasp (the headline). | A — the drone is the first hardware anyway |
| Q3 | Policy provider form | **ONNX runtime in the bot-node** (no Python at inference). | The container serves inference. | A — fewer moving parts at runtime |
| Q4 | The kinematic sim's role | **Certification gate** every policy must pass before it may propose. | Retire it once physics exists. | A — it is the rails; it stays |

## Build order (when accepted)

1. Parts model + MJCF generator: the kitchen, the recon-mini drone (masses, inertias, motors as
   actuators with aero-lab curves, sensor sites), the sim-6 arm from its DH table; STL meshes from
   the designer. The engine container with MuJoCo and Gymnasium; health and version surfaced like
   aero-lab's.
2. The sensor bridge: the container streams LiDAR sweeps, depth frames, rangers and state into the
   TypeScript engine over the node rail; the discovered map, registration and guards run unchanged.
   This is also BACKLOG B15 (the single-plane sensor logic) and the `PhysicsBackend` interface.
3. Task 1 (hover + leg) with a PPO baseline and the deterministic autopilot as the reference; seeded
   evaluation in the kinematic sim; the `drone.register` cadence as a hard constraint.
4. Task 2 (exploration policy vs the frontier planner).
5. Arm MJCF and task 3 (reach-and-grasp vs taught pick-and-place); then task 4 (door pull under the
   tip budget).
6. Policy-as-provider rail with the confirm gate; hardware-in-the-loop — the printed drone's node
   replaces the container behind the same primitives.

## Related

- [ADR-151](./151-eyes-and-hands-embodied-swarm.md) — the machine, Q1–Q5.
- [Recon drone hardware](../architecture/embodied-recon-drone-hardware.md) — the airframe this lab
  simulates first; its §2 records what the kinematic sim already knows about the sensor set.
- [Mobile manipulator hardware](../architecture/embodied-mobile-manipulator-hardware.md) — the arm.
- `aero-lab` — the propeller and airframe lab; its engine container is the packaging precedent.
- `scan-to-print` (ADR-150) — the STL writer and printer rail.
- `embodied` BACKLOG B15–B17 — the package-side work items this ADR creates.
