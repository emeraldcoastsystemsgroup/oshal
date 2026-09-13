# Runbook — the Embodied Swarm tile

The store package `embodied` is the simulation environment for the machine in
[ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md) and [ADR-152](../adr/152-embodied-physics-and-training-lab.md).
Everything it shows is simulated and says so. This is how a person drives it and how an operator keeps
it running. Package reference: `oshal-applications/embodied/README.md`.

## Open it

`/cockpit/?app=embodied` — the **Embodied Swarm** tile. Under ADR-149 enforce the person needs the
`@app-admin` grant for `embodied` (provision it in `/access`); without it every route answers 401.

## The loop, as clicks

1. **Explore the room.** Header button. Tick **drone first (rover parked)** to send the drone alone.
   Confirm the dialog. The badge shows `auto`, the header shows the running step, the 3-D view fills
   with mapped voxels, the **Discovered surfaces & objects** tables fill, and the **Command log** shows
   every step `accepted` then `completed` (registration sweeps are their own `drone.register` rows).
   The run ends with the badge back on `idle` and the drone `landed`, `anchored`.
2. **Draft a plan.** Task panel: *Clear a discovered surface* takes `from` / `to` from the discovered
   ids the exploration found. **Draft plan** shows the rehearsal verdict — `Rehearsal OK on a clone`
   or `REFUSED` with the reason. Nothing moves.
3. **Execute.** Confirm the dialog. The plan is rehearsed again on the live world, then runs; every
   kinetic step is re-validated against the map as it goes. **Abort** stops it; **E-STOP** latches
   (reset with **Reset e-stop**).
4. **Take command.** Pauses any plan and enables the manual buttons: base LiDAR / wrist camera / drone
   LiDAR scans, jog, lift, arm, gripper, drone take off / land. A refused command shows a toast with
   the reason and is a `refused` row in the log. **Release command** resumes the plan.
5. **Reset world.** Header: choose **Drone sensors** (`3-D LiDAR` we would buy, or `2-D ring + ToF`
   we print) and the **truth model** (`kinematic truth`, or `physics (MuJoCo)`), then Reset world.
   The map is forgotten; the machine starts knowing nothing.
6. **Build the drone.** The parts model for a fit; **Open in CAD Studio** on a part creates it as a
   real CAD model in the CAD Studio package and opens it there (CAD Studio must be installed and the
   person granted to it, or the toast says so). **design as markdown** is the hardware document's tables.

## The physics engine (optional)

The kinematic truth model needs nothing. The physics one needs the package's engine container once
per box:

```bash
docker exec oshal-local-api sh /app/workspace-shared/deployed-apps/embodied/engine/install-engine.sh
```

It builds `oshal-embodied-engine:local` from the official python image and the package's pins
(MuJoCo, Gymnasium, CPU-only PyTorch — the first build downloads them), starts it in its own compose
project on the stack network (alias `embodied-engine:7413`, no host port), and runs the self-test
(rest on the pad, climb, hover, ring sweep). The tile's header then reads
`physics engine: mujoco 3.3.5 connected`; otherwise it shows the reason and this command.

- A reset on `physics (MuJoCo)` that answers **503 `physics_unavailable`** means the container is
  down, unreachable, or built from another engine tree (the build hashes differ) — re-run the install.
- `GET /api/embodied/physics/status` is the same check as JSON; `GET /api/embodied/physics/mjcf?fit=`
  is the model the container loads.
- Training runs inside the container, not through the tile:

```bash
docker exec oshal-embodied-engine python /opt/embodied/engine/tasks/train_hover.py --timesteps 300000 --seed 0
```

writes `/tmp/embodied-reports/hover-leg-absolute-seed0.json` and the policy zip beside it (PPO vs the
plant's own controller on the same seeded episodes, a three-facet verdict); `--residual` learns a
bounded correction on the controller instead; `--rescore <policy.zip>` re-evaluates a saved policy.
`GET /api/embodied/physics/reports` lists them. Reports live in the container's tmpfs and are gone
on recreate — copy out what you want to keep.

## The plant as a node on the swarm rail

Run from inside the api container, `install-engine.sh` also makes the engine container a **node on the
swarm** (ADR-099, the way the drone and camera nodes join): it inherits `SWARM_SERVICE_SECRET` from the
api's environment, passes it to the container (never to a file), and the container heartbeats into
`POST /api/embodied/nodes/heartbeat` as `embodied-plant` every two seconds and takes command envelopes
at `embodied-engine:7414`. A node belongs to one person: set `EMBODIED_NODE_OWNER_SUB` to that
person's sub (the operator's, `OSHAL_OPERATOR_SUBS`, on the dev box) before running the installer —
the heartbeats carry it as the trusted service user identity and only that person's worlds see the
node. The installer prints `node rail: on`, who owns it, and, after the self-test, waits for
`node rail: the api acknowledged the plant's heartbeat`; run from a shell without the secret it prints
`node rail: OFF` and the bridge alone serves.

**Status on this box (2026-09-13): refused by core.** Under ADR-149 enforce the application
authorization guard answers `401 authorization_identity_required` to the node's heartbeats — with the
secret alone and with the owner's trusted sub — because its actor resolver admits only a session or a
controller-minted workload delegation. The installer therefore ends with the 20 s warning, the
container log reads `heartbeat rejected by the controller: HTTP 401`, and the tile's header says
`rail: no node has heartbeat in`. The dialled bridge (`physics (MuJoCo)`) is unaffected. The drone and
camera packages' node heartbeats sit behind the same gate. The decision is core's and is recorded in
the package's BACKLOG B20 with the evidence.

- The tile's header reads `rail: embodied-plant online`; the truth-model selector then offers
  **rail node embodied-plant (mujoco 3.3.5)**. Reset world on it and the node panel reads
  `physics on rail node embodied-plant`; the plant is now flown over the node's command channel, every
  step an authenticated envelope, through the same guards, rehearsal and confirm.
- A reset onto it that answers **503 `node_offline`** means no heartbeat for 15 s — the container is
  down or cannot reach the api (`docker logs oshal-embodied-engine`: look for `heartbeat failed` or
  `heartbeat rejected`). **404 `unknown_node`** means nothing of that id has ever heartbeat in.
  **503 `node_unavailable`** names the reason (the node refused the secret, or its build is not this
  package's engine tree — reinstall).
- `GET /api/embodied/physics/status` lists the fleet (`nodes`: online, `stale`, telemetry, events).
- A real drone node joins the same way (kind `drone`, refusing `load` and `clone`) — BACKLOG B6.

## Flying a trained policy (the certification gate)

1. **Explore first.** The gate replays the policy's recorded flight through *your* world's map; a
   map that has seen nothing certifies nothing. With the printed drone's single scan plane the path
   must also stay in scanned layers: if the verdict says `unknown space beside the path` a few
   centimetres under the mission altitude, take command and scan a pass one layer down along the leg.
2. **Policies panel → Certify** on a report. The toast says `Certified` or `Refused at N points` with
   the first guard's reason and where. A refused verdict does not certify; scan more and retry.
3. **Reset world** with the truth model on `physics (MuJoCo)` and the controller selector on
   `flown by <policy>` (it lists only policies you certified). The plant is now flown by the policy;
   the node panel says so. Every plan, guard, rehearsal and confirm is the same as before.
4. A reset with an uncertified policy answers 409 `policy_not_certified`; a policy on the kinematic
   truth model answers 400.

## Installing and updating the package

The package is installed like every store package (LF-exact archive of the store commit into
`deployed-apps/embodied`, `.oshal-install.json` carrying the commit, api restart). Two things bite:

- A failed manifest load flips the `swarm_applications` row to `inactive` and it stays so after a
  clean reload: every route answers **503 "owning app is inactive"**. Re-activate the row and restart
  the api (`update swarm_applications set status='active' where name='embodied'`).
- The Test Lab catalog (`tests/test-lab.yaml`) is validated strictly on load; an `expected` line with
  a colon parses as a mapping and fails the whole manifest. Validate with js-yaml before installing.

## Tests, and what each one proves

| Suite | Proves | Needs |
|---|---|---|
| `node --test "tests/engine-*.test.js"` | the engine: kinematics, base, drone, perception, localisation, sensor sets, designer, physics seam on a plant double, one regression case per single-plane defect | nothing |
| `tests/routes.core.test.js` | the routes over loopback HTTP, owner scoping, confirm gate, physics routes with a plant injected and without an engine | a core checkout |
| `tests/surface.core.spec.mjs` | the shipped tile in headless Chromium over the real routes: explore to done, manual command, reset, the CAD Studio hand-off byte for byte | a core checkout (Playwright) |
| `engine/tests/test_worker.py` | the MuJoCo plant against the generated fixture | python + the pins |
| `tests/engine-physics.live.test.js` | the simulation on the real plant behind a running bridge | `EMBODIED_ENGINE_ADDR` |
| `node --test tests/engine-node.test.js` | the node rail without a container: the fleet, a node double on loopback flown by the sim, a body that refuses to be cloned | nothing |
| `tests/engine-node.live.test.js` | the real plant started as a node against the real routes: heartbeat in, a world reset onto it, a fresh-world exploration to done on MuJoCo | `EMBODIED_PYTHON` + a core checkout |
