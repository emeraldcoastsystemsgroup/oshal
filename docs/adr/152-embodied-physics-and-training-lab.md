# ADR-152 — Embodied physics and training lab: our parts, in a 3-D world, under physics, without the hardware

**Status:** Accepted, 2026-09-13 (proposed the same day; the operator delegated the four open decisions:
*"you're in charge"*). Built as `embodied` 0.7.0 the same night — see *As built* below. Extends
[ADR-151](./151-eyes-and-hands-embodied-swarm.md) (eyes and hands; "sim first" accepted). Depends on the
two hardware designs ([mobile manipulator](../architecture/embodied-mobile-manipulator-hardware.md),
[recon drone](../architecture/embodied-recon-drone-hardware.md)), the `aero-lab` propeller work and the
`scan-to-print` STL rail.

## Context

The operator's ask, verbatim in spirit: *we need a virtual environment with our specs working in a 3-D
world — we have these parts and we have a physics — that can help us model without the actual hardware,
so we can train the arms and the drones.*

What existed when this was written (store package `embodied` 0.4.0):

- a deterministic 3-D world: a hidden box scene, a voxel occupancy map built from simulated LiDAR and
  depth pictures, discovery of surfaces and objects, scan-to-map registration, a six-axis arm with
  forward and inverse kinematics, a rolling base with a stability budget, a kinematic drone with a
  believed and a true pose;
- the rails: plans drafted against the discovered world, rehearsed on a clone, executed behind a
  confirm, every kinetic step re-validated against the map, a command log, command authority;
- the parts, as numbers: masses, reach, tip budget, sensor placements, propulsion sizing, printable
  geometry — in the two hardware documents, not yet as a model a physics engine can load.

What it was not: a physics engine. Nothing had inertia. The arm moved kinematically between joint
targets; the drone's autopilot flew a belief to a point; contact was a rule ("rests on the highest
top beneath the tool"), not a force. That is exactly right for proving rails and guards, and exactly
wrong for training a controller or a grasp.

Training needs three things the kinematic engine cannot give: rigid-body dynamics with contact
(an arm that can miss, push, drop, tip), thousands of episodes per hour, and sensor emulation from
the actual geometry of the parts we intend to print.

## Decision

**D1 — One parts model, three consumers.** The parametric specs (the two hardware docs, aero-lab's
propeller curves, scan-to-print's STL geometry) become one machine-readable parts model in the
`embodied` package: masses and inertias, joint limits and torques, motor thrust and torque curves,
sensor poses and fields of view, mesh files. The STL printer reads it to print; the physics lab reads
it to simulate; the kinematic sim reads it for its constants. A number lives in one place.

**D2 — MuJoCo in an engine container.** The physics lab is a Python engine container in the
`embodied` package, following the `aero-lab` and `cad-studio` precedent (a package-owned container on
the stack network). MuJoCo (Apache-2.0) simulates the kitchen, the printed drone and the arm from MJCF
generated from the parts model; Gymnasium wraps the tasks; MJX is the optional GPU path when episodes
per hour matter more than a laptop can give. Sensors are emulated in the engine: LiDAR by batched ray
casts, depth by rays through the pinhole, rangers as rays.

**D3 — The TypeScript engine stays the authority.** Rails, guards, the discovered map, registration,
planners and the command log do not move into Python. The physics container is a *plant* the
simulation drives: it speaks the same primitives (take off, go to, land, scan) and returns the same
sensor frames a real drone node will. `WorldSim` gains a `PhysicsPlant` seam — `kinematic` (the
odometry model) or `physics` (the container) — and every guard runs unchanged on either. Sim-to-real
is a change of endpoint, not of code.

**D4 — Training lane, fail-closed.** Policies are trained in the container on Gymnasium tasks with
seeded determinism and evaluated, before anything else, in the kinematic sim against the same
rehearsal rails a human's plan gets. A policy that passes becomes a *provider* (ADR-151 Q5 option B
becomes reachable): it proposes actions; the confirm rail, the tip budget, the map guards and the
e-stop still own whether they happen. No policy ever bypasses a guard, in sim or on hardware.

**D5 — First tasks, in this order.** (1) Drone position hold and one-leg flight under a disturbance
model, on the recon-mini airframe: the fastest path to a flying part. (2) Frontier exploration as a
policy, scored against the deterministic frontier planner it must beat. (3) Arm reach-and-grasp on
discovered objects, with the taught pick-and-place as the baseline it must beat. (4) The fridge door
pull with the tip budget as a hard constraint in the reward. Each task ships with its deterministic
baseline, so a learned policy is always compared to something that already works.

## Decisions taken on the open questions (2026-09-13, delegated by the operator)

| # | Decision | Taken | Why (cost / benefit) |
|---|---|---|---|
| Q1 | Training compute | **CPU MuJoCo on the box** | Nothing to buy; the dev box runs Docker at 6 GB with no GPU; the drone tasks train in minutes (80 000 PPO steps in 222 s). GPU + MJX when the arm tasks start and minutes matter. |
| Q2 | First learned task | **Drone hover + one leg** | The drone is the first hardware anyway; the task exercises the whole lane (MJCF, plant, controller baseline, report) with the smallest state. |
| Q3 | Policy provider form | **The container serves inference** (Option B) | Option A (ONNX in the bot-node) needs core code; the core is load-bearing and rarely touched, and a policy-as-provider does not exist yet (BACKLOG B19). Revisit when a policy has passed the gate. |
| Q4 | The kinematic sim's role | **Certification gate** | It is the rails. A policy's flight must pass `droneClear` and the fence point by point before it may propose (B19). |

## Options considered

| Option | For | Against |
|---|---|---|
| Extend the TypeScript engine into a physics engine | one language, deterministic, no container | months to make contact and dynamics credible; no training ecosystem; reinvents MuJoCo badly |
| **MuJoCo + Gymnasium in a container (chosen)** | the standard for robot learning; fast, accurate contacts; MJCF from code; MJX for GPU batches; Apache-2.0 | a Python container to maintain; one more engine on the box (aero-lab and cad-studio set the precedent) |
| PyBullet | easy, free | stagnant, weaker contacts, slower |
| Isaac Sim / Isaac Lab | photoreal, massive GPU parallelism | NVIDIA GPU required, heavy, licence friction, oversize for a kitchen |
| Genesis / other new engines | promising | unproven here; revisit in a year |
| Webots / Gazebo | full robot suites | GUI- and ROS-centred; the swarm is the orchestrator, not ROS |

## As built — `embodied` 0.7.0 (2026-09-13)

- **MJCF from the parts model** (`src-routes/engine/physics/mjcf.ts`): every solid a sensor can strike
  as a named box; the drone as one free body with the summed mass budget (0.746 kg for recon-mini),
  an inertia estimated from where the parts sit, four thrust actuators with a reaction torque of
  0.012 N·m/N (placeholder until aero-lab's curves), sensor sites at the kinematic sim's offsets. The
  generated model is the engine's committed test fixture; a test pins the two together.
- **The plant** (`engine/embodied_worker.py`, MuJoCo 3.3.5): cascaded position/attitude control with
  yaw slewed and desaturated, setpoint-velocity feed-forward, a seeded gust, phase-aware contacts,
  `settled`, and every sensor as `mj_multiRay` from the true pose with the kinematic raycaster's
  geometry. Measured: rests at its 3 cm pad plate; holds the mission altitude within 8 cm under the
  gust; tracks a 1 m/s ramp with under 25 cm of lag; reports a real contact when flown into the island;
  deterministic per seed with exact clone/restore. Six pytest cases.
- **The seam** (`physics/plant.ts`, `sim/world-sim.ts`): the autopilot ramps a setpoint the plant
  chases; the belief dead-reckons the command and is corrected by the sensors; a finished phase is held
  until the plant settles; a strike is a contact. The plant double runs a drone-first exploration
  through every guard; the live suite does the same on MuJoCo to done, landed, not down.
- **The bridge** (`physics/bridge-client.ts` + a worker thread): synchronous by design (the simulation
  step is one), hello-verified (protocol, version, build hash), 503 with the install command when down.
- **The container** (`engine/container/`, `install-engine.sh`): python:3.11-slim + the pins, CPU-only
  PyTorch, its own compose project on the stack network, built locally (369 MB) and self-tested.
- **Task 1** (`engine/tasks/hover_leg.py`, `train_hover.py`): the Gymnasium environment, the plant's
  controller as the baseline, PPO training, one report. Baseline: 1.0 cm at the end of the hold,
  1.5 cm at the end of the leg, no crashes over 10 seeded episodes. PPO after 80 000 steps: 3.3 cm and
  4.1 cm, 60 % success — **does not beat the baseline yet**; the report records it.
- **Two shared-code guards the physics lane exposed and fixed:** a simplified flight leg could clip a
  cell corner Bresenham skipped (flight legs now use a supercover line test); a climb overshoot of
  centimetres past the fence ceiling refused every next leg (the path is judged from the nearest
  in-fence point within 30 cm).
- **One body radius (B18, 0.7.1):** every guard reads the hull from the parts model of the fit that
  carries the sensor set — 0.178 m half-width for the printed drone plus a 5 cm margin laterally, the
  hull's height plus the mast plus the margin vertically — the same hull the plant collides with. The
  kitchen re-measured at that clearance: 92.7 % of tops in 12 goals, the same dishes found.
- **The certification gate and the policy as the plant's controller (B19, 0.8.0):** every evaluation
  records the first episode's flight path; `POST /physics/certify` replays it point by point through
  the owner's fence and map guards (unknown space refuses) and remembers a passing policy for that
  owner; `POST /world/reset {controller:'policy:<file>'}` then loads the plant with the policy as its
  flight controller, inference in the container (Q3 as decided), the setpoint ramp, belief, map
  guards, `drone.goto`, rehearsal and confirm untouched. A hover-and-leg policy is a controller, so
  it flies the legs the rails give it; proposing legs is the exploration policy's job (D5.2, open).
  The verdict has three facets (mean error, endpoints, crashes) and needs all three. Residual training
  (a bounded correction on the controller) exists. Measured: absolute PPO at 400 000 steps on two
  seeds and residual PPO at 200 000 steps win the mean-error facet and lose the endpoints (0.8–4.1 cm
  against the controller's 0.6 cm) — no policy has beaten the controller yet; the reports say so. A
  single-plane map certifies nothing off its scan plane: a path that dips centimetres under the
  mission altitude is refused until those layers are scanned — the gate working as meant.
- **Not built, recorded as BACKLOG with done-when:** the node rail for the plant (B20 — today a
  package-owned TCP bridge), a training recipe that beats the controller on three seeds (B19), tasks
  D5.2–D5.4.

## Consequences

- **Positive.** The parts we print, the physics we train in, and the numbers the kinematic sim
  guards with come from one model. Training does not wait for hardware; hardware, when it comes,
  plugs into the same seam the container used. Learned behaviour is gated by the same rails as a
  human's plan. The physics lane already found two guard defects the kinematic model could not.
- **Negative.** A Python container joins the package (install, health, version pinning — the
  cad-studio recipe). Training costs compute; CPU MuJoCo gives thousands of steps per second per
  environment, GPU is optional and a later decision. Physics fidelity of printed parts is only as good
  as the measured masses and the propeller curves — weigh at assembly, measure at the bench.
- **Deferred.** Photoreal rendering for vision policies; multi-drone and multi-arm coordination;
  learned perception (discovery stays geometric until labels from pictures land, BACKLOG B11).

## Build order and status

1. Parts model + MJCF generator; the engine container with MuJoCo and Gymnasium; health and version
   surfaced — **done 0.7.0** for the kitchen and the recon drone; the sim-6 arm's MJCF is D5.3.
2. The sensor bridge into the unchanged map and registration and the `PhysicsPlant` seam — **done
   0.7.0** over a package-owned bridge; the swarm node rail is B20.
3. Task 1 with a PPO baseline and the deterministic autopilot as the reference — **done 0.7.0**; the
   certification gate and the policy as the plant's controller — **done 0.8.0**; no policy beats the
   reference yet (B19).
4. Task 2 (exploration policy vs the frontier planner) — open.
5. Arm MJCF and task 3; then task 4 — open.
6. Policy-as-provider behind the confirm gate; hardware-in-the-loop — B19, B20, B6.

## Related

- [ADR-151](./151-eyes-and-hands-embodied-swarm.md) — the machine, Q1–Q5.
- [Recon drone hardware](../architecture/embodied-recon-drone-hardware.md) — the airframe this lab
  simulates; its §11 records the plant model the physics lab flies.
- [Buy decision](../architecture/embodied-buy-decision.md) — what the simulation proves before money leaves.
- [Mobile manipulator hardware](../architecture/embodied-mobile-manipulator-hardware.md) — the arm.
- `aero-lab` — the propeller and airframe lab; `cad-studio` — the engine-container packaging precedent.
- `scan-to-print` (ADR-150) — the STL writer and printer rail.
- `embodied` BACKLOG B17–B20 — the package-side work items this ADR created and left open.
