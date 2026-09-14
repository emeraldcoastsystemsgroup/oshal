# ADR-151: Eyes and hands, no body — drones perceive, detached arms act, every peripheral is a swarm node

**Status:** Accepted — simulation environment BUILT (2026-09-12, operator: *"you are authorized
to perform the full build… if we can make a simulation environment that would be great"*). Store
package `embodied` (oshal-applications) implements D1 (capability manifests + validator), D2 (the
sim `ManipulatorProvider` as guarded primitives on a sim-6 arm), D3 as a sim world model (objects
with poses on surfaces; the Spaces object layer is still open), D4 (draft → rehearsal → confirmed
execute → live re-validation → command log) and D5 (confirm rule by safety class) against a
simulated kitchen, mini drone and rolling arm. No hardware, no core change. Open: Q1–Q5 below,
and the real-node lane in the package's BACKLOG.
**Extends:** [ADR-099](099-drones-as-remote-swarm-nodes.md) (each drone = a remote swarm node),
[ADR-114](114-user-owned-remote-nodes.md) (device-bound enrollment, owner-scoped execution),
[ADR-111](111-spatial-mapping-3d-reconstruction.md) (the Spaces world model), [ADR-150](150-deterministic-object-reconstruction-scan-to-print.md)
(the occupancy grid), [ADR-036](036-bot-owned-application-architecture.md) (the bot owns its domain).
**Companion:** [embodied-mobile-manipulator-hardware.md](../architecture/embodied-mobile-manipulator-hardware.md)
— the mobile base, the stability budget, real parts and the assembly sequence.

## Context

The operator's framing (2026-09-12): the swarm already has a drone program, a LiDAR and image
mapping program, and camera ops. Give it mechanical arms as well and it becomes physically
capable — **not a humanoid**, but *"autonomous, single, six-degree-of-freedom robot arms, about
six feet tall, that can grab a dish or open a refrigerator"*. The drones are the eyes; the
arms are detached workers; and there could be any number of other peripherals, each a
specialised robot for one kind of task.

That framing is the right one for this platform, because everything it needs already has a
shape here. Nothing below is a new architecture; it is the existing one applied to a third
kind of physical device.

### What exists today (as built — verify with the linked ADRs before re-flagging)

| Capability | Where | Posture it already enforces |
|---|---|---|
| A physical device is a **swarm node** with its own agentId, heartbeat, authenticated envelopes, audit log | ADR-099, `src/app/drone-node-server.ts`, store package `drone` | No raw device link on the network. Commands only through the swarm. |
| Enrolling somebody's hardware and **binding it to its owner** | ADR-114, `POST /api/join/enroll`, device-bound `oshal_pat_` tokens | The swarm-wide shared secret is retired as a worker credential. |
| A kinetic action is **drafted by a bot and executed only by a human**, re-validated against the fence at execution time | `drone` package: `draft-drone-mission` / `execute-drone-mission`; `drone_command_log` | Confirm rail; land / RTL / abort are confirm-exempt. |
| **Sim first**, then the real vehicle behind the same interface | `SimDroneProvider` → `MavlinkDroneProvider` (SITL-proven) | Every command shape proven without hardware. |
| A **world model** of a space: splat + camera poses + `.ply` import | ADR-111 Spaces (store package `spaces`), phone/iOS ingest | Owner-scoped scans; RF is an overlay, never geometry. |
| A **binary occupancy grid** written by silhouettes, depth and LiDAR alike | ADR-150 `scan-to-print` engine (`carveDepth`, voxelize, surface nets) | Deterministic, no model in the geometry path. |
| Cameras as nodes (GoPro over USB, browser webcam) | store package `camera` | Same "device = node + cockpit surface" stack as drone. |
| A physical prop driven **only through a manifest-declared, owner-resolved tool** | store package `pumpkin` (projector over a paired SSE room) | A bot cannot obtain the pairing token; the tool is the only door. |
| A generic owned worker node that executes one claimed task at a time | `packages/oshal-chat` remote client, A2A `mcp.call-tool` | Owner-scoped dispatch since 2026-07-23. |
| The **physics plant as a swarm node**: the embodied engine container heartbeats in and takes command envelopes exactly as a drone node does; the sim flies it through `RailDroneNode` beside the dialled `RemotePlant` | ADR-152, store package `embodied` 0.9.0 (`/api/embodied/nodes`, `auth: service`) | The seam a real drone node fills (embodied BACKLOG B6): same envelopes, kind `drone`, no `load`, no `clone`. |
| A **PX4 flight stack as a drone node**: the official SITL image (SIH physics) flown over MAVLink in OFFBOARD behind the same envelopes; its own estimate is the truth, the scene is cast from that pose | ADR-152, store package `embodied` 0.11.0 (`embodied_px4_node.py`, `install-engine.sh --with-px4`) | Kind `drone`: refuses `clone` (the rehearsal runs on the kinematic twin); every leg through the unchanged guards and confirm. Proven in the sandbox; the hardware is embodied BACKLOG B6. |

What does **not** exist: any manipulator provider, any notion of an object with a pose and an
affordance inside a Spaces scan, any "physical task" ticket type, and any device-kind-agnostic
peripheral contract (drone, camera and the remote client each carry their own node runtime and
heartbeat shape).

### The honest hard part

Flying a waypoint mission is a solved, deterministic problem given a fence. **Grasping an
arbitrary dish or opening an arbitrary refrigerator is not.** General-purpose manipulation of
unknown objects is a research problem (learned policies, force control, contact-rich planning).
This ADR does not pretend the swarm solves it. It scopes the platform's contribution to what
it is actually good at, and keeps learned manipulation as a pluggable skill behind the same
confirm rail:

- **A world model the arm can trust** — the scene it acts in is the Spaces scan plus the
  occupancy grid, so "where is the dish" and "what must the arm not hit" are questions
  answered by geometry the platform already produces.
- **Deterministic skills over known objects** — a dish on a marked shelf, a fridge handle with a
  fiducial, a bin at a taught pose. Fiducials (ArUco) are already in the capture playbook.
  The first useful arm is a taught one, not a clever one.
- **Perception–act–verify as a loop with a human gate**, not one-shot autonomy.

## Decision

### D1 — Every peripheral is a swarm node of a declared *kind* and *safety class*

Generalise ADR-099 from "a drone is a node" to **"a peripheral is a node"**. A peripheral node
runs at the device (companion computer, pedestal controller, ground station), enrols with a
device-bound token (ADR-114), heartbeats telemetry, and accepts commands only as authenticated
swarm envelopes. Its enrolment carries a **capability manifest**:

```yaml
kind: manipulator            # drone | camera | manipulator | printer | light | <new kinds>
model: xarm-6                # adapter id; `sim-*` for simulators
safetyClass: 2               # see D5
senses: [joint-state, wrist-camera, force-torque]
acts: [move-to-pose, grasp, release, open-handle, e-stop]
envelope:                    # the fence, in the node's own frame
  reach_m: 1.2
  keepOut: []                # filled from the world model at pairing (D3)
```

The manifest is validated fail-closed at enrolment exactly as `swarm-apps/*.yaml` manifests
are (unknown kind, unknown act, missing safety class → refused). It is what lets the swarm
answer "what can act on this room" without a per-vendor question.

### D2 — Arms mirror the drone stack exactly: a `ManipulatorProvider` interface, sim first

```ts
interface ManipulatorProvider {
  readonly armId: string; readonly kind: 'sim' | 'xarm' | 'ur-rtde' | 'ros2' | 'remote';
  enable(): Promise<void>;                 // power + brakes off; rejected on fault
  disable(): Promise<void>;
  moveToPose(pose: Pose6, speed: Speed): Promise<void>;   // Cartesian, IK on the node
  moveJoints(q: number[], speed: Speed): Promise<void>;
  grasp(width: number, force: number): Promise<void>;
  release(): Promise<void>;
  executeSkill(skill: SkillPlan): Promise<void>;          // validated multi-step plan
  abort(): Promise<void>;                  // confirm-exempt, like land / RTL
  eStop(): Promise<void>;                  // confirm-exempt; latches until human reset
  getTelemetry(): ArmTelemetry;            // joints, TCP pose, wrench, gripper, faults
  getEvents(sinceSeq: number): ArmEvent[];
}
```

- **Sim provider first** — deterministic FK/IK over a URDF-shaped joint model, reach envelope,
  self-collision and keep-out checks, a simulated wrench. Every route, validator and confirm
  path is proven against it before a motor turns (the drone precedent: sim → SITL → airframe).
- **Hardware adapters, one per vendor, behind the same interface.** Recommended order: a
  vendor SDK adapter for whichever collaborative arm the operator actually buys, then a
  **ROS 2 bridge adapter** (topics / MoveIt 2 actions) as the wide-compatibility path. ROS is
  an adapter, not the substrate — the substrate is the swarm rail (ADR-099 §1).
- **A "six-foot arm"** is a collaborative 6-DOF arm on a fixed column or a slow mobile base. It
  needs a gripper with force limiting, a wrist camera, and an e-stop the node can assert without
  the controller. The node is fail-closed: link loss → hold and brake (the arm analogue of the
  drone's link-loss self-RTL).

### D3 — The world model is Spaces, extended with objects; the fence is the occupancy grid

No new scene store. A Spaces scan (ADR-111) grows an **object layer**: named objects with a
pose in the scan frame, a bounding volume, and declared affordances (`graspable`,
`openable(handle-pose, hinge-axis)`, `placeable-surface`). Objects are added by:

1. **Teaching** — an operator drives the arm to the object and names it (the reliable path).
2. **Fiducials** — ArUco-tagged handles and shelves resolve to poses deterministically.
3. **Drone / camera re-scan** — the perception fleet updates the scan; the ADR-150 occupancy
   grid derived from it is what the manipulator's **keep-out** is computed from.

"The drones are the eyes" is literally this: a drone scan mission (ADR-111 phase 3, sim-first
already built) refreshes the scan the arm plans against. The same loop verifies the outcome
(re-scan after act → the object moved or it did not).

### D4 — A physical task is a ticket: perceive → localise → plan → approve → execute → verify

A new store package (`embodied` or `arm-ops`, suite `ai-home` or `ai-engineering`, operator's
call) registers a `physical-task` ticket type with one worker bot, exactly like
`intelligent-operations` registers `incident-remediation`. The bot owns the domain
(ADR-036): it reasons over the world model and the capability manifests, drafts a **skill
plan** (a validated sequence of manipulator/drone/peripheral commands with pre- and
post-conditions), and persists it as `status='draft'`. A human executes it through one confirm
route that re-validates every step against the *current* world model and envelope at execution
time. Every actuating command lands in a `peripheral_command_log` (the `drone_command_log`
shape, keyed by node).

The bot never holds a device credential and never emits a raw command; it emits a plan the
package validates. This is the pumpkin/drone posture applied to arms.

### D5 — Safety class decides how much rail a command needs

| Class | Examples | What the swarm requires |
|---|---|---|
| 0 sensing | camera frame, LiDAR scan, joint state | Owner scope only. No confirm. |
| 1 low-energy | light, speaker, projector, printer job | Owner scope + audit. Confirm per app doctrine (printer already confirms). |
| 2 kinetic | arm motion, gripper, drone flight, mobile base | Draft → human execute; fence re-validated at execution; e-stop / abort confirm-exempt; node fail-closed on link loss; audit every command. |
| 3 hazardous | heat, blades, chemicals, anything near a person by design | **Refused** unless the operator enables that specific device, per act, in `/access` — and then class-2 rails apply. |

Standing authorisation ("always tidy the counter at 21:00") is **opt-in per zone and skill**,
default off — the automation directive, unchanged. The first rung is per-task approval.

### D6 — Store, not core; one kernel question stays open

Everything above ships as store packages (arm node runtime, manipulator providers, the
`physical-task` app, Spaces object layer as a Spaces package increment). Core is touched
**only** if the operator accepts the one kernel-level proposal below; without it, the arm
package carries its own node runtime the way `drone` and `camera` do today.

## Open decisions for the operator (cost / benefit)

| # | Decision | Option A | Option B | Recommendation |
|---|---|---|---|---|
| Q1 | **Generic peripheral node contract** (D1) | **Kernel skill `peripheral-nodes`**: one enrolment + heartbeat + command-log rail every device kind reuses. *Gain:* drone/camera/arm stop carrying three copies; "what can act here" is one query. *Cost:* a core change (needs approval, one deploy), and migrating drone/camera later. | **Per-kind stacks** as today: the arm package copies the drone node runtime. *Gain:* zero core touch, ships sooner. *Cost:* a fourth copy of the same rail; no cross-kind view; reversal later is a migration of every kind. | A, but **after** the sim arm proves the command set — extract the skill from two working kinds, not one. |
| Q2 | **Control stack** (D2) | **Vendor SDK adapter first** for the arm actually purchased. *Gain:* thin, fast, no ROS install. *Cost:* one adapter per vendor. | **ROS 2 / MoveIt 2 bridge first**. *Gain:* wide hardware reach, mature planning. *Cost:* a heavy dependency on the node box; a second process model to keep fail-closed. | A first, B as the second adapter. Both stay behind the same interface. |
| Q3 | **Where objects live** (D3) | **Extend Spaces scans** with an object layer. *Gain:* one owner-scoped world model, poses already in the splat frame. *Cost:* Spaces package grows a migration. | **New scene-graph store** in the arm package. *Gain:* isolation. *Cost:* two world models that drift; the drone re-scan cannot update the arm's view. | A. |
| Q4 | **Hardware before or after sim** | **Sim first**, buy after the command set and the fence are proven. *Gain:* the drone precedent; nothing wasted on the wrong arm. *Cost:* later gratification. | **Buy an arm now**. *Gain:* real contact data early. *Cost:* the vendor choice fixes Q2 before the interface is proven. | A. |
| Q5 | **First skill** | **Taught pick-and-place over fiducial-marked objects**. *Gain:* deterministic, demoable, honest. *Cost:* not "any dish". | **Learned grasping** (a policy provider) from day one. *Gain:* the headline. *Cost:* research-grade reliability under a kinetic safety class. | A; a learned policy becomes one more `executeSkill` provider later, under the same rail. |

## Consequences

- **Positive:** the platform's existing security model (owned nodes, confirm rails, audit,
  fail-closed nodes) covers arms with no new trust surface; the perception fleet and the
  effector fleet share one world model, so "eyes" and "hands" are the same scan; every device
  kind grows the same way (sim → adapter → real), so the catalogue of peripherals is open-ended
  by construction.
- **Negative:** general manipulation stays out of scope — the first arms are taught, not
  clever, and the ADR says so on the surface. A class-2 device adds real physical risk; the
  rails are software, so a hardware e-stop and a collaborative-rated arm remain mandatory.
- **Deferred:** mobile bases (a class-2 kind of their own), multi-arm coordination (the fleet
  mission analogue), standing authorisations, learned skill providers.

## Build order (when accepted)

1. Sim `ManipulatorProvider` + node runtime + envelope validator, in a store package, with the
   command set proven by unit tests and one route-chain test (no core change).
2. `physical-task` ticket type + worker persona + draft/execute confirm routes + command log.
3. Spaces object layer (teach + fiducial), keep-out from the ADR-150 grid.
4. First vendor adapter on purchased hardware; e-stop and link-loss proven on the bench.
5. Drone re-scan → verify loop; then the Q1 kernel extraction if accepted.
