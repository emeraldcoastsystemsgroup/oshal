# PteroSim as an outside reference for our simulators

**Research note, 2026-09-28.** Backlog entry *Compare our simulators against PteroSim (2026-09-15)*
([BACKLOG.md](../../BACKLOG.md)); the ROADMAP row *Simulator comparison — PteroSim* stays a roadmap
item until the entry closes. This is evaluation, not adoption. Everything below about PteroSim comes
from its public pages, read on 2026-09-28 and listed under [Sources](#sources); PteroSim was **not
downloaded, installed or run** — doing so requires accepting a proprietary EULA, which is the
operator's consent to give, not an agent's (see [Licence position](#4-licence-position-recorded-before-any-dependency)).

What is recorded here, and what is not:

| | state |
|---|---|
| The five-axis comparison and a verdict per simulator | written below |
| The licence position against our actual use, purchase decisions named | written below |
| The cross-check harness (same vehicle, same manoeuvre, divergence) | built: store package `embodied` 0.17.0, `engine/crosscheck/` |
| The PX4 SIH leg of the cross-check, run and recorded | **done, twice** — [sih-trajectory.json](./sih-trajectory.json), [sih-trajectory-repeat.json](./sih-trajectory-repeat.json), [sih-repeatability-divergence.json](./sih-repeatability-divergence.json) |
| The PteroSim leg | **not run** — waits on the operator's licence decision (section 4) |
| The final verdict for the PX4 node | *oracle, pending the cross-check*; every other simulator's verdict is final |

## 1. What PteroSim is

- A "UAV Flight Simulation Platform built on Unreal Engine 5" [pterolabs]; "Flight dynamics are
  computed by JSBSim" [gh-readme]. Aircraft ship as folders "of JSBSim XML and glTF meshes, shipped
  loose in `PteroSimAircrafts/`" [gh-readme].
- Flight stacks: PX4, ArduPilot and Betaflight SITL [gh-readme]. To PX4 it is "proprietary
  simulation software that can be used with PX4 for Software-In-The-Loop (SITL) simulation" that
  "uses the Simulator MAVLink API over TCP port 4560 with lockstep synchronization" [px4-docs]. PX4 is
  built and started as `PX4_LOCKSTEP=1 PX4_SIM_SPEED_FACTOR=1 make px4_sitl_default none_iris`
  [px4-docs]; in PteroSim one chooses PX4 "in the control source panel", spawns "the aircraft (e.g.
  F450)", and "lockstep engages once PX4 connects" [docs-px4] — PX4 is the side that connects, the
  simulator listens. PX4 marks the integration "community supported and maintained" and says it "may
  or may not work with current versions of PX4 and may be removed in future releases" [px4-docs].
- Programmatic access: a Python SDK (`pip install pterosim`) and a "Programmatic gRPC API for
  multi-drone orchestration" [gh-readme]. Sensors: "IMU, GPS, barometer, airspeed, camera"; "Camera
  video streams are encoded by FFmpeg" [gh-readme].
- Platforms and footprint: "Windows 10 64-bit / Ubuntu 22.04" minimum, "Windows 11 / Ubuntu 24.04"
  recommended; 8 GB RAM, a GTX 770 / RX 570 class GPU, 5 GB of storage [gh-readme]. Windowless runs:
  `-nullrhi` is the "null render hardware interface" for "when You only need physics, dynamics, and
  non-visual sensors" — "Physics only, no cameras (lightest footprint)" is `-nullrhi -nosplash` with
  "Minimal — no GPU"; `-RenderOffScreen` "renders to an off-screen buffer" for "camera sensors,
  screenshots, or pixel data"; `-nosplash` skips the splash screen and `-unattended` declares "there
  is no interactive user, suppressing engine dialogs" [docs-headless].
- Speed: "6x to 10x faster than real-time", but simulation speed-up is a Pro-tier feature; the Free and
  Edu tiers run in real time [pterolabs].

## 2. The comparison, five axes

Each of our simulators against PteroSim on: the physics it solves, what it renders, which flight
stack it drives, how a bot or node calls it, and what it costs to run. Store paths are in
`oshal-applications`; core paths are in this repository.

| simulator | physics solved | renders | flight stack | how a bot or node calls it | run cost |
|---|---|---|---|---|---|
| **PteroSim** (reference) | JSBSim 6-DOF rigid-body flight dynamics for the aircraft folders it ships; on the Free tier the F450 multicopter ("The free tier includes the F450 multicopter" [px4-docs]; fixed-wing, VTOL and helicopters are paid) | an Unreal Engine 5 world; cameras as FFmpeg video, or nothing under `-nullrhi` | PX4, ArduPilot or Betaflight SITL, PX4 over the lockstep Simulator MAVLink API on TCP 4560 | a host process over gRPC or the Python SDK; a flight stack over MAVLink. In our shape nothing on the swarm rail would speak to it — the existing PX4 node ([`embodied/engine/container/embodied_px4_node.py`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/embodied/engine/container/embodied_px4_node.py)) would fly PX4 `none_iris` with PteroSim as the physics behind it, a configuration change (compose profile `px4-external`), not new code | a Windows or Ubuntu host with 8 GB RAM; a GTX 770-class GPU for rendering, none for physics-only; 5 GB on disk; real time on Free and Edu; one vehicle, 2 h sessions with a 5 h cooldown on Free; a licence per tier (section 4) |
| **aero-lab** — persistent-flight design lab | a custom two-timescale trajectory / energy integrator in 3-DOF (`aero-lab/engine/aerosim/integrate.py`: the dynamic pass at dt = 0.05 s and the energy pass at dt = 60 s are held in agreement; thrust acts along the flight path), wing polars from AeroSandbox / NeuralFoil section data, a 24 h energy limit cycle and an admissibility screen. JSBSim was tried and **rejected** there: the recon "measured +16,313 ft2/s2 of manufactured specific energy" at a wind-field step (`aero-lab/engine/aerosim/env/wind.py:21-22`), and a shear-harvesting design's whole budget is a difference of wind between two altitudes | plots (SOC trace, polar, drag build-up, margins) and a build package (STL / DXF / BOM); no scene | none — there is no autopilot in the loop; the vehicle flies a prescribed schedule | package routes to a package-owned engine container over a TCP bridge (`aero-lab/engine/container/aero_engine_bridge.py`); the api image is Alpine and casadi ships glibc-only wheels, hence the container | one CPU container, `mem_limit ${AERO_ENGINE_MEM_LIMIT:-2g}`, no GPU; cost scales with the design sweep, not with wall time |
| **embodied — the MuJoCo physics lab** ([ADR-152](../../adr/152-embodied-physics-and-training-lab.md)) | MuJoCo 3.3.5 rigid-body dynamics with contacts, an MJCF generated from **our** parts model (the printed recon drone, the printed arm), a gust model, the package's cascaded controller, and PPO training against it (`embodied/engine/embodied_worker.py`, `embodied/src-routes/engine/physics/mjcf.ts`) | no scene; ray sensors cast in the MuJoCo world, the cockpit tile draws voxels, poses and pinhole pictures from the sim | none — the package's own controller or a trained policy | the api dials the engine bridge (JSON-lines over TCP, alias `embodied-engine`, no host port) or the node rail (`embodied_engine_node.py`) | one CPU container, `mem_limit ${EMBODIED_ENGINE_MEM_LIMIT:-2g}`, read-only root, no GPU; training is CPU-bound |
| **embodied — the kinematic twin** | no dynamics: believed and true poses, an autopilot setpoint ramp, an occupancy map, and the rails (plan, rehearse, confirm, re-validate) — the certification gate a policy must pass before it may fly the plant (`embodied/src-routes/engine/{drone,sim}/`; `embodied/docs/ARCHITECTURE.md`) | the cockpit 3-D view: mapped voxels, the arm model, simulated pictures | none | in the api process, through the package routes | none beyond the api |
| **embodied — the PX4 SIH node** | PX4's own in-firmware SIH model (PX4 1.18.0): a rigid body with mass and inertia, per-rotor maximum thrust and torque, arm levers, linear and angular drag (`SIH_KDV`, `SIH_KDW`), a rotor time constant (`SIH_T_TAU`) and ground contact — no scene, no aerodynamic model beyond that | nothing | **PX4 SITL** — the real controller, EKF and commander, flown in OFFBOARD | `embodied_px4_node.py` over MAVLink (one fixed-port UDP socket, setpoints at 10 Hz) as a `drone`-kind node on the rail (compose profile `px4`, `embodied/docs/ARCHITECTURE.md` §6e) | one `px4io/px4-sitl` container (the cross-check caps it at 512 MB), real time, no GPU |
| **drone package + core `SimDroneProvider`** ([ADR-098](../../adr/098-drone-ops-app.md), [ADR-099](../../adr/099-drones-as-remote-swarm-nodes.md)) | a deterministic kinematic flight simulator: lazy time integration in ≤ 1 s sub-steps, geofence, battery failsafes (low → RTL, critical → land), a rotor-RPM model for the HUD ([`src/features/drone/services/sim-drone-provider.ts`](../../../src/features/drone/services/sim-drone-provider.ts)) | the Drone Ops HUD and map | none in the sim; its sibling [`mavlink-drone-provider.ts`](../../../src/features/drone/services/mavlink-drone-provider.ts) drives an ArduPilot / PX4 controller in GUIDED mode over signed MAVLink v2 TCP and was live-proven against ArduPilot SITL | `/api/drone/*` → `DroneService` → the provider behind one `DroneProvider` interface; a fleet node heartbeats under the service secret | in the api process |
| **drone-relay — the scenario sims** ([ADR-155](../../adr/155-drone-relay-chains.md)) | deterministic tick simulations of a relay formation: drones are arc lengths on a corridor or points on a lattice with a battery, links judged by the transport's modelled edge, reachability walked from the base, the controller's roster and elastic targets (`drone-relay/src-routes/engine/{relay-sim,lattice-sim,tree-sim}.ts`) — no vehicle dynamics at all | a design document and plan tables | none | in the api process, through the package routes and the designer concierge | none beyond the api |
| **Spaces — the Sim reconstruction engine** ([ADR-111](../../adr/111-spatial-mapping-3d-reconstruction.md)) | none: it "generates a real, renderable synthetic room .splat (deterministic in the scan id)" and synthetic poses so the pipeline and viewer run with no GPU; "It does NOT claim to reconstruct the uploaded video" ([`sim-reconstruction-provider.ts`](../../../src/features/spatial-mapping/services/sim-reconstruction-provider.ts)) — it reconstructs, it does not fly | a WebGL splat viewer | none | `/api/spaces` → `SpatialMappingService` → a `ReconstructionProvider` (Sim or Edge) | in the api process; the Edge provider needs the GPU box that ADR-111 lists as roadmap |

**Not flight.** `ocean-lab` (blade-element momentum rotors, panel-method polars, the 300 mm wave
explorer; "Every model runs in-process and deterministically") and `sat-ops` ("Sim engines only: the
in-process RK4 gyrostat or the NASA 42 referee. Commands cannot leave simulation.") simulate no
aircraft. PteroSim does not apply to either.

## 3. Verdicts

Per simulator: is PteroSim a **cross-check oracle**, a **replacement**, or **neither** — and why.

| simulator | verdict | reason |
|---|---|---|
| aero-lab | **neither** | It answers a different question — a 24 h energy limit cycle for a solar-endurance aircraft of our own geometry, on a wind field whose continuity is a physics decision. JSBSim is the class of model aero-lab measured adding energy at wind steps, which is the quantity aero-lab budgets. On the Free tier the airframe is an F450 multicopter and fixed-wing is a paid tier, and aero-lab's aircraft are not stock airframes in any tier. There is no oracle relation for the number aero-lab computes. |
| embodied MuJoCo lab | **neither**, as built | Not a replacement: the lab's purpose is *our* parts model (the printed drone, the printed arm) under contacts, and PteroSim flies its own aircraft folders; loading a foreign MJCF is not something its pages describe. Not a direct oracle: different vehicle, and our cascaded controller or policy rather than PX4. The outside check of a plant that flies the same controller runs through the PX4 node — the cross-check below — and that measures SIH, not MuJoCo. The camera-in-the-loop gap stays open. |
| embodied kinematic twin | **neither** | A rails-and-guards certification gate with no dynamics; nothing physical to check against. |
| embodied PX4 SIH node | **oracle, pending the cross-check** | Both sides run the same PX4 firmware, controller and commander over the same Simulator MAVLink API; the vehicle is one declared file (below) and the manoeuvre is fixed. A divergence past the declared tolerances therefore isolates the physics model — PX4's SIH or PteroSim's JSBSim F450 — and is a finding about one of them. The harness is built and the SIH leg is recorded here; the PteroSim leg is gated by the licence decision in section 4. Should the operator decline, the verdict becomes *neither: licence* and the entry closes. |
| drone package / `SimDroneProvider` | **neither** | A kinematic mission-and-fence simulator has no dynamics to cross-check, and the deterministic sub-stepped model is what the fleet tests rely on. Separately, PteroSim would be *a SITL vehicle* behind the existing `MavlinkDroneProvider` (PX4 or ArduPilot over MAVLink) — a use of the adapter, not a verdict on the simulator — and the Free tier's one vehicle cannot exercise the fleet shows. |
| drone-relay scenario sims | **neither** | They answer chain connectivity and formation rules on modelled link edges; a flight simulator does not answer that, and multi-vehicle runs are a paid tier. |
| Spaces Sim engine | **neither** | It reconstructs rather than flies. A rendered PteroSim camera could one day be *capture video* for the Edge provider (ADR-111's roadmap names real-drone media ingest and a MAVLink follow-up), which is a source, not a replacement of the Sim provider. |
| ocean-lab, sat-ops | not flight | No aircraft; PteroSim does not apply. |

## 4. Licence position, recorded before any dependency

**How we would actually use it.** One scripted, single-vehicle cross-check: the F450, one fixed
manoeuvre of about 45 s of simulated time per run (the recorded SIH runs span 44.5 s and 44.6 s on
the vehicle's clock), a handful of runs, in real time, windowless, with no camera, as an evaluation
published in this research note. Against the Free tier's limits [pterolabs, px4-docs, gh-readme]:

| Free-tier limit | our cross-check use | fits? |
|---|---|---|
| 1 concurrent vehicle | one vehicle | yes |
| the F450 on the PX4 path | the F450 is the vehicle the harness declares | yes |
| "2 h of sim time (5 h cooldown)" | ~45 s per run; a session of a dozen runs is minutes | yes |
| no simulation speed-up | real time is what the lockstep clock expects; not needed | yes |
| no wind / turbulence control | not needed for the cross-check manoeuvre (a gust comparison would be Edu or Pro) | yes |
| "Free for non-commercial, personal, and academic use" [gh-readme]; commercial use "✗" [pterolabs] | an evaluation inside an open-core project run by a company — **the EULA does not define the Free tier's permitted purposes** [eula], so whether this qualifies is the operator's call | **decision** |

**Purchase decisions, named, not assumed.** Any of the following exceeds the Free tier and is a
purchase, decided by the operator, before it is planned for:

- **Multi-vehicle** (drone-relay chains, fleet shows, ADR-099 formations): Edu, $20/mo, 5 concurrent
  vehicles, no session limit, non-commercial; or Pro, unlimited, contact for pricing [pterolabs].
- **Faster than real time** (thousands of training episodes per hour, ADR-152): Pro [pterolabs].
- **Fixed-wing, VTOL or helicopter airframes** (anything aero-lab-shaped): paid tiers [px4-docs].
- **Wind / turbulence control** (a gust comparison against the MuJoCo lab's gust model): Edu or Pro
  [pterolabs].
- **Any commercial or product use** — a shipped oshal capability that depends on it, or work for a
  customer: Pro; the Edu tier "is licensed for non-commercial educational, academic, and research use
  ONLY; any commercial use requires a Pro license" [eula, sec. Edu].

**EULA facts** [eula], "PTEROSIM END-USER LICENSE AGREEMENT", last updated September 2026:

- Consent (section 10) is given "by clicking 'I Accept' in the application, or by setting the
  environment variable PTEROSIM_ACCEPT_EULA=Y, or by passing the -AcceptEula command-line flag —
  including when launching PteroSim in a headless, automated, or container environment". Without it
  the process "prints a notice and exits with code 1" [docs-headless]. **That consent is the
  operator's**: no agent, script, Dockerfile (`ENV PTEROSIM_ACCEPT_EULA=Y`) or Test Lab case sets it.
- Redistribution is prohibited (section 2.c: "Distribute, sublicense, lease, rent, or lend the
  Software to third parties"), so any container image that carries PteroSim is **built locally and
  never pushed to a registry or committed**; nothing of PteroSim's enters either repository.
- Termination (section 7): "effective until terminated"; PteroLabs AI may terminate on any failure to
  comply.
- We found **no clause about benchmarking or publishing comparison results**; the Free tier's
  permitted purposes are **not defined** in the agreement.

**The decision the operator owns**, one of three: (a) accept the EULA for a Free-tier evaluation and
run the PteroSim leg; (b) buy Edu ($20/mo) or Pro; (c) decline — then the PX4 node's verdict is
recorded as *neither: licence* and the backlog entry closes under its fourth clause. Until then no
dependency on PteroSim exists anywhere: not in a manifest, a compose file, an installer or a test.

## 5. The cross-check: designed, the SIH leg recorded, the PteroSim leg pending

Built in store package `embodied` 0.17.0 (`engine/crosscheck/`, BACKLOG B28); tested by
`engine/tests/test_px4_crosscheck.py` (14 cases, standard library only) and `tests/engine-crosscheck.test.js`;
Test Lab cases `engine-crosscheck` and `engine-px4-crosscheck-sih`.

**The manoeuvre**, fixed and versioned (`takeoff-leg-yaw-hover-land` v1, sha256 `2807676e…88deec`;
a change to any number is a new manoeuvre the divergence refuses to compare with the old one):
takeoff to 2 m, held 8 s; a 5 m leg north, held 8 s; a 90° yaw, held 5 s; a 10 s hover; `LAND`.
Setpoints stream at 10 Hz in OFFBOARD; each segment is held on the **vehicle's** clock, so a lockstep
simulator running slower than wall time gets the same simulated seconds.

**The vehicle**, one declared file (`f450-sih.params.json`, sha256 `a19fa06f…ed51ef`): a 450 mm
X quad of 1.2 kg (DJI's published F450 wheelbase and the midpoint of its takeoff-weight range), four
90 g rotor units at the arm tips plus a uniform central box, thrust-to-weight 2, rotor moment
coefficient 0.05 (the value both PX4 airframes give the allocator). From those inputs follow the eight
SIH values (`SIH_MASS` 1.2, `SIH_IXX/IYY` 0.011135, `SIH_IZZ` 0.021375, `SIH_T_MAX` 5.884,
`SIH_Q_MAX` 0.2942, `SIH_L_ROLL/PITCH` 0.1591) and the eight allocator positions
(`CA_ROTOR0..3_PX/PY` ±0.1591). On the SIH backend all sixteen are set by `PARAM_SET` and each is
confirmed by the vehicle's `PARAM_VALUE` echo before arming; on the external backend only the
allocator geometry is sent (the physics is the simulator's). Thirty-three controller parameters
(`MPC_*`, `MC_*`, `CA_ROTORn_KM`) are read back from both stacks so the divergence can refuse two runs
flown by different controllers; the three SIH values the file does not set (`SIH_KDV`, `SIH_KDW`,
`SIH_T_TAU`) are recorded at PX4's defaults. A vehicle whose `SYS_AUTOSTART` is not the backend's SITL
airframe (10040 `sihsim_quadx`, 10016 `none_iris`) is refused before a single `PARAM_SET`. The file's
own `status` says what it is: our declaration, not yet reconciled with the F450 PteroSim flies —
that reconciliation (its JSBSim XML ships in the release under `PteroSimAircrafts/`, readable after
the EULA) is the first step of the PteroSim leg.

**The divergence** (`divergence.py`): both runs are expressed about their own rest pose (the mean
position and circular-mean heading over the last second at rest), each commanded phase is aligned
from **its own** command in each run and resampled at 20 Hz over the shorter of the two durations
(a setpoint one run sent a tick later is harness timing, not a model difference), then per axis
(north, east, up, yaw) the RMS and maximum error and per leg the 10–90 % rise time, overshoot and
settling time are compared against declared tolerances: position RMS 0.25 m, max 0.75 m; yaw RMS 5°,
max 15°; rise 0.5 s, overshoot 10 %, settling 1.0 s. A metric past its tolerance is a **finding
about one of the two models — the report names both and never says which**. A different manoeuvre,
a different vehicle file, an unconfirmed vehicle, a controller parameter that differs, or an
unfinished run is refused by name.

### The SIH leg, run and recorded

Flown standalone on 2026-09-28 with the package's `run-leg.sh` recipe: a private docker network,
`px4io/px4-sitl:latest` started as `/opt/px4/bin/px4` with `PX4_SIM_MODEL=sihsim_quadx` (the image's
entrypoint bypassed, stdin open, 512 MB), the harness in the engine image `oshal-embodied-engine:local`
with the engine tree mounted read-only, nothing on the stack network, no host port, both containers
and the network removed afterwards; the api rail was never involved. The reproducing command, from
the package directory:

```bash
bash engine/crosscheck/run-leg.sh sih <out-dir>            # writes <out-dir>/sih-trajectory.json and sih-px4.log
python engine/crosscheck/divergence.py --self-check <out-dir>/sih-trajectory.json
```

| | run A — [sih-trajectory.json](./sih-trajectory.json) | run B — [sih-trajectory-repeat.json](./sih-trajectory-repeat.json) |
|---|---|---|
| started (UTC) | 2026-09-28 03:49:13 | 2026-09-28 03:50:15 |
| PX4 (`AUTOPILOT_VERSION`), airframe | 1.18.0, `SYS_AUTOSTART` 10040 | 1.18.0, 10040 |
| vehicle confirmed | 16 of 16 parameters echoed back | 16 of 16 |
| rest pose (NED m, heading) | (−0.004, −0.001, −0.014), 0.16° | (−0.001, −0.003, −0.002), 0.73° |
| samples | 2210 position, 2234 attitude, 44.5 s | 2211 position, 2234 attitude, 44.6 s |
| events (vehicle clock, run A) | offboard-armed 5.26 s → takeoff 5.26 → leg-north 13.32 → yaw-90 21.42 → hover 26.44 → land 36.50 → landed 46.26 | same seven, complete |
| PX4 log | `Ready for takeoff!` → `Armed by external command` → `Takeoff detected` → `Landing at current position` → `Landing detected` → `Disarmed by landing` | same |
| `divergence.py --self-check` | ok | ok |

The 33 controller parameters read back are identical between the two runs (e.g. `MPC_XY_P` 0.95,
`MPC_Z_P` 1.0, `MPC_XY_VEL_P_ACC` 1.8, `MPC_Z_VEL_P_ACC` 4.0). The recorded runs are the harness's
raw output; nothing was edited.

**Repeatability — the floor any external leg is read against** ([sih-repeatability-divergence.json](./sih-repeatability-divergence.json),
run B against run A, 820 resampled points over five phases): verdict **agree**, no finding.

| axis | RMS | max |
|---|---|---|
| north | 0.022 m | 0.056 m |
| east | 0.020 m | 0.047 m |
| up | 0.022 m | 0.177 m |
| horizontal | 0.030 m | 0.056 m |
| yaw | 0.26° | 3.04° |

Per leg (B minus A): takeoff rise −0.080 s, settling +0.088 s, overshoot 0; leg-north rise −0.008 s,
overshoot −0.02 %, settling −0.004 s; yaw-90 rise +0.004 s, overshoot +0.27 %, settling −0.024 s.
The command offsets the report publishes (leg-north −0.028 s, yaw-90 −0.108 s, hover −0.128 s, land
−0.184 s) are the 10 Hz tick and segment-close jitter between two runs of one harness.

Two things this run taught, both now in the harness:

1. **A single alignment mis-reads harness timing as a model difference.** The first cut of the
   divergence aligned once, at OFFBOARD-accepted, and read these same two SIH runs as *diverge*
   with a yaw maximum of 23.5° — one run's yaw command had landed a tick later than the other's, so
   the 90° step was compared against a heading that had not yet been told to move. Aligning each
   phase from its own command reads the same two runs at 3.04°. A cross-check that had not been run
   against itself first would have published that 23.5° as a finding about SIH or JSBSim.
2. **The vehicle refusal works on real data.** An earlier run (03:45 UTC) against a previous edit of
   the vehicle file (sha256 `6cdb303a…`) is refused as `different_vehicle` and is not published.

### The PteroSim leg — what remains, exactly

Gated on section 4. Once the operator has accepted the EULA (or bought a tier) and confirmed the
Free tier fits the evaluation:

1. Reconcile `f450-sih.params.json` with the F450 PteroSim flies (mass, inertia, arm, thrust from its
   JSBSim XML under `PteroSimAircrafts/`); a changed declaration is a new vehicle revision, and the
   SIH leg is flown again from it so both legs declare one file.
2. On the Windows host (or a locally built, never-published Ubuntu 22.04 container), start PteroSim
   windowless — `-nullrhi -nosplash -unattended`, the operator's own `PTEROSIM_ACCEPT_EULA=Y` —
   choose PX4 as the control source and spawn the F450 (through the Python SDK for an unattended
   run; its calls are documented at [docs-python], not yet read). No window may open on the operator's
   desktop.
3. Fly the same manoeuvre through PX4 `none_iris` in lockstep against it, from the package directory:

   ```bash
   EMBODIED_PX4_SIM_HOSTNAME=host.docker.internal bash engine/crosscheck/run-leg.sh external <out-dir> pterosim-f450
   python engine/crosscheck/divergence.py <out-dir>/sih-trajectory.json <out-dir>/external-trajectory.json --out <out-dir>/divergence.json
   ```

   PX4 in the container dials the simulator on the host at TCP 4560 (`PX4_SIM_HOSTNAME`), lockstep
   engages when it connects, and the harness refuses to arm unless `SYS_AUTOSTART` is 10016.
4. Publish `external-trajectory.json` and `divergence.json` beside the SIH files here with the run
   metadata (PteroSim release, PX4 version, vehicle and manoeuvre hashes), and name any metric past
   its tolerance as a finding about SIH or about PteroSim's JSBSim F450 — read against the
   repeatability floor above, which is the smallest difference this method can attribute to a
   model at all.
5. Finalise the PX4 node's verdict, reconcile the ROADMAP row in the same change, and close the
   backlog entry through the house closure path.

Scheduling fact: the development box has 16 GB; PteroSim's minimum is 8 GB and the Docker engine
holds 4.5–6 GB, so the leg runs when the stack is quiet. The PX4 SITL container runs in about
45 s of simulated time per leg.

## Sources

Public pages, read 2026-09-28. PteroSim was not downloaded or run.

- [pterolabs] https://pterolabs.ai/ — product page and pricing table (Free / Edu $20 per month /
  Pro contact for pricing; concurrent vehicles 1 / 5 / unlimited; session "2 h of sim time (5 h
  cooldown)" / none; commercial use ✗ / ✗ / ✓; speed-up ✗ / ✗ / ✓; wind and turbulence ✗ / ✓ / ✓);
  "UAV Flight Simulation Platform built on Unreal Engine 5"; downloads at
  https://github.com/PteroLabsAI/PteroSim-UAV-Simulator/releases/latest.
- [gh-readme] https://github.com/PteroLabsAI/PteroSim-UAV-Simulator — README: JSBSim dynamics, PX4 /
  ArduPilot / Betaflight, system requirements, `pip install pterosim`, the gRPC API, sensors,
  `PteroSimAircrafts/`, "Free for non-commercial, personal, and academic use".
- [px4-docs] https://docs.px4.io/main/en/sim_pterosim/index — PX4's page: proprietary, Windows 10/11
  and Ubuntu 22.04+, Simulator MAVLink API over TCP 4560 with lockstep, the `none_iris` build
  command, "community supported and maintained", "The free tier includes the F450 multicopter".
- [docs-headless] https://pterosimdocs.readthedocs.io/en/latest/headless.html — render flags, the
  no-GPU physics-only recipe, headless EULA consent and the exit-1 behaviour, the Docker examples.
- [docs-px4] https://pterosimdocs.readthedocs.io/en/latest/sitl_simulation_px4.html — control source
  PX4, spawn the F450, lockstep engages when PX4 connects, PX4 in WSL2 reaching a hostname.
- [docs-python] https://pterosimdocs.readthedocs.io/en/latest/python_api.html — the SDK reference (not
  yet read for this note).
- [eula] https://github.com/PteroLabsAI/PteroSim-UAV-Simulator/blob/main/LICENSE — "PTEROSIM
  END-USER LICENSE AGREEMENT", last updated September 2026: sections 2.c, 7, 10 and the Edu clause.
- Ours: `oshal-applications` — `embodied/engine/crosscheck/` (the harness, the divergence, the
  vehicle file, `run-leg.sh`), `embodied/docs/ARCHITECTURE.md` §6e, `embodied/BACKLOG.md` B6 and B28,
  `aero-lab/engine/aerosim/integrate.py`, `aero-lab/engine/aerosim/env/wind.py`,
  `drone-relay/src-routes/engine/*-sim.ts`; this repository — ADR-098, ADR-099, ADR-111, ADR-152,
  ADR-155, `src/features/drone/services/`, `src/features/spatial-mapping/services/`.
