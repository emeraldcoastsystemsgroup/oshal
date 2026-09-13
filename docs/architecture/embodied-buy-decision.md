# Embodied — the buy decision: what the simulation proves before money leaves

Companion to [ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md), [ADR-152](../adr/152-embodied-physics-and-training-lab.md),
the [recon drone hardware design](./embodied-recon-drone-hardware.md) and the
[mobile manipulator hardware design](./embodied-mobile-manipulator-hardware.md). Every number here is
measured in the `embodied` package (0.7.0, 2026-09-13) or generated from its parts model; none is a
promise about hardware.

## The question

Two drones are designed on one frame: **recon-mini** (a 2-D LiDAR ring in the flight plane, a
downward ToF depth camera, zenith and nadir rangers; about $580 in bought parts) and **recon-3d**
(the same frame carrying a Mid-360-class 3-D LiDAR; about $1 450). Which to build first, and what
has to be true before either is bought?

## What the simulation proves

| Claim | Evidence | Where |
|---|---|---|
| The printed drone's single scan plane maps the kitchen | drone-first exploration on the kinematic model: 93.1 % of column tops seen in 13 goals / 15 registrations (92.7 % in 12 goals / 14 registrations once every guard keeps the printed drone's real 0.178 m hull, 0.7.1); basin and three counters discovered; both plates within 2 cm, the mug within 1 cm; home anchored with zero error | `tests/engine-sensor-sets.test.js` (0.5.0) |
| Scan-to-map registration recovers the pose from the map alone | point-to-plane ICP against the map's kept hit points: a 10 cm injected error returns under 1 mm (3-D set); planar registration in the ring's plane against walls at any height | `tests/engine-localization.test.js` (0.4.0) |
| The planned airframe flies under physics | MuJoCo plant from the parts model (0.746 kg, four motors at 3.66 N max): rests on its 3 cm pad plate, holds the mission altitude within 8 cm under a gust model, tracks a 1 m/s leg with under 25 cm of lag, reports a real contact when flown into furniture | `engine/tests/test_worker.py`, `tests/engine-physics.live.test.js` (0.7.0) |
| The same map and guards work on the physics truth | a drone-first exploration runs to done on MuJoCo with the unchanged map, registration and guards; the drone lands and re-anchors | `tests/engine-physics.live.test.js` (0.7.0) |
| A person can drive it | headless Chromium over the real routes: explore to done, manual commands, reset, the CAD hand-off byte for byte | `tests/surface.core.spec.mjs` (0.6.1) |
| The parts print | every printed part validates against CAD Studio's contract and opens there as a real CAD model | `tests/engine-build.test.js` (0.6.0) |

## What the simulation cannot prove

- **Sensor noise and reflectivity.** Rays are exact. A real LD19 at 12 m on a white wall is not; the
  registration's capture radius (15 cm) was set against exact returns.
- **The drift.** The kinematic odometry model is a fixed bias per metre; the physics plant's "drift"
  is a controller lag under a modelled gust. Neither is a measured IMU or optical-flow
  characterisation (BACKLOG B13).
- **The masses and the inertia.** The mass budget sums catalogue figures; the inertia is estimated
  from where the parts sit. Weigh every part and swing-test the frame at assembly.
- **The propeller.** Momentum theory with a figure of merit of 0.60 and a reaction-torque constant
  of 0.012 N·m/N; aero-lab's measured curves replace both.
- **Hardware failure modes.** A motor out, a prop strike, battery sag, radio loss: not modelled.
- **The node rail.** The plant is reached by a package-owned bridge; the real drone's node rail
  (B20, B6) has not carried a frame yet.

## What must be true before buying

1. **S4 hand-carried mapping** (hardware design §8): an LD19 and a ToF camera carried by hand through
   the kitchen at 2 m, streamed as sweeps into `POST /scan` (BACKLOG B5), must register against the
   map the simulation builds with the real sensor's noise. This is the one test the simulation cannot
   stand in for, and it costs the two sensors (about $150), not the drone.
2. **The propeller curve** from aero-lab for the 6 in prop at the hover rpm, so the hover time
   (10.2 min theoretical, 70–80 % real) is a measurement, not a figure of merit.
3. **The safety class.** The printed drone indoors is class 2 in ADR-151's ladder: prop guards
   mandatory, the ELRS kill switch is the hardware e-stop, and the geofence and battery failsafes are
   ArduPilot stock. None of this is negotiable for a first flight in a kitchen.

## Recommendation

Build **recon-mini** first, after S4. The simulation says its single scan plane is enough for this
room, its parts print, and its airframe flies under physics with margin; the 3-D sensor is held in
reserve as the same frame with a different mast. Do not buy the Mid-360 on the simulation's word:
it would be bought to answer a question (a cluttered room the ring cannot map) the simulation has
not been asked yet (BACKLOG B4, more scenarios).
