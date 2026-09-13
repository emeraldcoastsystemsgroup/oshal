# Embodied swarm — the recon drone, built from scratch

**Status:** design, 2026-09-13. Companion to [ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md)
and the [mobile manipulator hardware design](./embodied-mobile-manipulator-hardware.md). The
simulation this drone is designed against is store package `embodied` 0.4.0; the sections marked
*measured* quote that simulation, everything else is design and is labelled approximate.

The premise: the eyes of the machine are drones we print and assemble ourselves, not drones we buy.
We have a printer rail ([scan-to-print](https://github.com/emeraldcoastsystemsgroup/oshal-apps),
ADR-150), a propeller and airframe lab (`aero-lab`, the aerosim engine container), and a simulation
that has just written the sensor requirements. This document turns those into one buildable drone,
says what the simulation already knows about it, and names what the other threads have to deliver.

## 1. What the simulation wrote on the shopping list (measured)

The 0.4.0 build made the drone's pose an estimate and sent it blind. Every rule it needed to survive
is a hardware requirement:

| Rule the sim needed | What it means for the airframe |
|---|---|
| An upward ranger clears the column the drone climbs through; a spinning LiDAR tops out at +60° and cannot | a zenith time-of-flight ranger on the mast, 4 m |
| A nadir range gives altitude directly | a downward ranger, 8 m, plus the depth camera |
| The LiDAR must reach the far wall of the room | ≥ 8 m on a dark wall; 12 m class |
| Registration after every ≤ 2 m flown, while hovering | a sweep in under a second; the hover is the pause |
| 15 cm clearance to every mapped voxel = 10 cm body + 5 cm drift | body radius ≤ 12 cm including guards, or the clearance grows |
| The pad fiducial re-anchors the belief on landing | a downward camera and a printed pad with an AprilTag |
| Drift budget 2 % along, 0.5 % across, 0.57°/m heading | optical flow + IMU; the budget is a placeholder until measured (BACKLOG B13) |
| Flight at 1.9 m under a 2.3 m ceiling, 10 cm over the fridge | a flat airframe, guards above the props |
| An exploration is ~12 scans and a few legs; the whole clear-surface loop under 5 simulated minutes | 8–10 min hover with margin |

## 2. The sensor-set decision — and what the sim says about it (measured)

Two sets fit the rules. The simulation was asked to map the kitchen drone-first with each:

| Set | Mass of the sensing | Result in the 0.4.0 sim |
|---|---|---|
| **3-D spinning LiDAR**, 64 rings × 240 azimuths, 8 m (a Livox Mid-360 class sensor, ~265 g, 360° × 59°) | ~265 g + rangers | 90.9 % of the room known in 7 registrations, both plates and the mug found within 1 cm, the rover plans against the map |
| **2-D ring + downward ToF depth camera** (an LDRobot LD19 class ring, ~47 g, 12 m, ~450 points/rev; an Arducam ToF class camera, 70° × 50°, 4 m; zenith + nadir rangers) | ~80 g | *first attempt, 0.4.0 scratch harness:* 8–26 % known, 0–1 registrations, exploration stalls. *With the single-plane logic built (0.5.0, `recon-mini`):* 93.1 % of column tops seen in 13 goals and 15 registrations, the basin and three counters discovered, both plates within 2 cm and the mug within 1 cm, home anchored with zero error |

The first 2-D result was an honest "not yet", not a verdict on the sensor: a single scan plane only
tells you about its own plane, and every part of the exploration and registration logic assumed a
sensor that sees above and below. The 0.5.0 build gave the printed set its own rules, and the sim
now says it can do the job:

1. **The scan plane is the flight plane.** The guards read the voxel layer at the drone's altitude;
   the ring flies in that layer, at a voxel-centre altitude 20 cm under the ceiling so a fridge just
   under the plane sits below the clearance band rather than inside it.
2. **Altitude from the nadir ranger, every step**, read against the discovered top under the drone;
   only a top with known free air above it counts, and only the reading that moves the belief least.
3. **Registration is planar**: x, y and yaw against vertical-face anchors at any height, every ring
   point used, 100 matches enough. A sweep with nothing to match is dead-reckoned, never "lost".
4. **The height map comes from the depth camera**, and exploration chases the columns the camera has
   not seen, choosing the goal by what it will learn over how far it flies, never scanning twice from
   the same spot (a cabinet's shadow is unseen from above the cabinet).

Decision for this design stands: **one parametric airframe, two fits.** *Recon-mini* carries the 2-D
set and is the one we print first; the simulation now backs it. *Recon-3D* is the same frame with a
300 g payload bay and 7-inch props for the Mid-360 class sensor, held in reserve for a room the
2-D set cannot map.

## 3. Propulsion sizing (computed, momentum theory)

Hover power from disc loading: `P_ideal = W^1.5 / sqrt(2 ρ A)`, `P_electrical = P_ideal / (FM · η)`
with figure of merit 0.60 and motor + ESC efficiency 0.75; usable energy 80 % of nominal at 3.7 V per
cell. These are textbook placeholders; the aero-lab propeller module replaces FM with the printed
blade's measured curve (§7). Real hover time lands at 70–80 % of the figure below.

| Props | AUW | Battery | Disc loading | P electrical | Hover (theory) | Thrust per motor: hover / T:W 2 |
|---|---|---|---|---|---|---|
| 5 in | 750 g | 4S 1500 mAh, 175 g | 145 N/m² | 126 W | 8.5 min | 188 g / 375 g |
| **6 in** | **750 g** | **4S 1500 mAh, 175 g** | **101 N/m²** | **105 W** | **10.2 min** | **188 g / 375 g** |
| 6 in | 850 g | 4S 2200 mAh, 240 g | 114 N/m² | 127 W | 12.3 min | 213 g / 425 g |
| 7 in | 750 g | 4S 1500 mAh, 175 g | 74 N/m² | 90 W | 11.9 min | 188 g / 375 g |
| 7 in | 1300 g (recon-3D) | 6S 2200 mAh, 330 g | 128 N/m² | 205 W | ~9 min | 325 g / 650 g |

Tip speed at a plausible hover rpm: 6 in at 9000 rpm is 72 m/s, 5 in at 14 000 rpm is 93 m/s. Keep it
under ~75 m/s indoors: the 6-inch prop is quieter and more efficient at the same thrust, and the
airframe grows by 35 mm in wheelbase for it. **Choose 6 in, 750 g, 4S 1500 mAh.**

Motors: 2306 class, 1700–1900 KV on 4S (≈ 30 g each, ~1 kg peak thrust each on a 6-inch prop, so
T:W at full throttle is over 4 — plenty; the limit is noise and guards, not lift). ESC: 4-in-1, 35–45 A.

## 4. Airframe — every structural part prints on a 220 × 220 mm bed

**Layout.** X-quad, wheelbase 260 mm (motor to diagonal motor). Adjacent 152 mm props then clear each
other by 32 mm. The centre stack is 110 × 110 mm; arms are separate parts bolted with M3 so a broken
arm is a 40-minute reprint, not a new frame.

| Part | Qty | Size (approx.) | Material | Print notes |
|---|---|---|---|---|
| Centre plate, top and bottom | 2 | 110 × 110 × 4 mm, 30.5 mm and 20 mm stack patterns, arm sockets | PETG or PA-CF | flat, 6 walls, 40 % gyroid |
| Arm with integral motor mount | 4 | 130 mm, 14 × 14 mm box section, 16 × 16 / 19 × 19 mm motor pattern | PA-CF (PETG acceptable) | flat, solid infill, 0.2 mm layers |
| Prop guard segment | 4 | quarter ring, 170 mm inner Ø, 12 mm tall, 3 struts to the arm | TPU (95A) or PETG | mandatory indoors; guards sit *above* prop plane as well as around it |
| Sensor mast | 1 | hollow, 40 mm (recon-mini) or 80 mm (recon-3D), LD19 plate on top | PETG | vertical, 4 walls |
| ToF camera and flow mount | 1 | nadir bracket under the bottom plate, lens window 30 × 40 mm | PETG | |
| Battery tray | 1 | 80 × 36 mm channel, two strap slots | PETG | |
| Landing feet | 4 | 25 mm, on the arm underside | TPU | |
| Landing pad | 1 | 200 × 200 × 20 mm plate, 100 mm AprilTag (36h11) recess, alignment ridge | PETG, tag printed on paper under a clear insert | the fiducial the pad fix reads |

Print everything at 0.2 mm layers except the mast top (0.12 mm for the LiDAR seat). No PLA: it creeps
under a strapped battery in a warm room and snaps at the arm root. Weigh every part as it comes off
the bed and write the figure on it; §5 is a budget, not a measurement.

## 5. Mass budget (approximate; replace with scale readings at S3)

| Item | g |
|---|---|
| Centre plates, mast, tray, mounts, feet (printed) | 140 |
| Arms ×4 (printed, solid) | 60 |
| Prop guards ×4 | 45 |
| Motors 2306 ×4 | 120 |
| Props 6 in ×4 (printed ~7 g each; commercial ~5 g) | 28 |
| 4-in-1 ESC | 15 |
| Flight controller | 10 |
| Raspberry Pi Zero 2 W | 11 |
| LD19 LiDAR | 47 |
| ToF depth camera | 20 |
| Rangers ×2 (TFmini-S class) | 10 |
| Optical flow, downward camera | 7 |
| RC receiver, buzzer, LED | 8 |
| Battery 4S 1500 mAh | 175 |
| Wiring, straps, fasteners | 50 |
| **All-up** | **~746** |

## 6. Electronics and the node

| Role | Part class | Why this one |
|---|---|---|
| Flight controller | H7-class board running **ArduPilot Copter** (Matek H743 / Kakute H7 class) | rangefinders, optical flow, MAVLink companion, geofence and battery failsafes are stock; no kernel code written for flight control |
| ESC | 4-in-1, 35–45 A, BLHeli_32 or AM32 | one board, bidirectional DShot for rpm telemetry |
| Motors | 2306 1700–1900 KV ×4 | §3 |
| Ring LiDAR | LDRobot LD19 / D500 class | 47 g, 12 m, 360°, UART, ~4500 points/s |
| Depth camera | Arducam ToF class (0.15–4 m, 240 × 180) | light-independent; gives the height map from 1.9 m. Alternative: OAK-D Lite (61 g, stereo + compute) |
| Rangers | TFmini-S class ×2 (zenith, nadir), 12 m | the climb column and the altitude fix |
| Flow | PMW3901 | the dead-reckoning the drift budget models |
| Pad camera | Pi Camera Module 3, pointed down | AprilTag on the pad → the pad fix |
| Companion | **Raspberry Pi Zero 2 W** | runs the drone-node client only; the map, registration and plans run in the swarm |
| Radio | ELRS receiver | the manual kill switch — the hardware e-stop this class needs |
| Power | 4S 1500 mAh LiPo, XT30, power module with current sense | |

Indicative cost, 2026 street prices, approximate: **$350–450** for recon-mini excluding printer
filament; the recon-3D fit adds ~$1 000 for the sensor and a bigger battery.

**Where the brain is.** The Pi streams LiDAR sweeps, ToF frames, rangers and flight-controller state
to the swarm over the drone-node rail (ADR-098/099, the `drone` package's heartbeat and command
channel) and takes back goto / scan / land. The engine that registers sweeps, builds the map and
refuses illegal moves is the one already running in `embodied`; the drone does not get a copy. This
is the same pipe the physics lane uses (ADR-152), so sim-to-real is a change of endpoint, not of code.

## 7. What the propeller thread (aero-lab) has to deliver

- Static thrust and torque versus rpm for printed 5-, 6- and 7-inch two-blade props, plus the curve
  to 3 m/s axial inflow. That replaces FM = 0.60 in §3 and sets the sim's motor model.
- Blade geometry for printing: chord and twist tables, hub for a 5 mm shaft / M5 nut, root thickness
  ≥ 2.5 mm, recommended orientation and layer height (0.12 mm), PETG or PA.
- A balancing procedure (the printed prop will not be balanced off the bed).
- A tip-speed cap for an occupied room: 75 m/s unless the lab shows a quieter profile.

What this design gives back: thrust targets 188 g hover and 375 g at T:W 2 per motor; 4S voltage;
2306 KV range; the mass table above.

## 8. Assembly and bring-up

| Step | Gate before the next |
|---|---|
| **S1 Print.** All parts of §4; fit-check arms in sockets, stack spacing, LiDAR seat | every part weighed and written on |
| **S2 Bench, props OFF.** Motors, ESC, FC, Pi; ArduPilot flashed; ESC calibration; motor order and direction | all four spin the right way at the right throttle |
| **S3 Sensors on the bench.** LD19 streaming to the Pi, ToF frames, both rangers, flow, pad camera detecting the printed tag at 0.3–2 m | the drone-node client reports every sensor to the swarm |
| **S4 Hand-carried mapping.** Carry the powered drone around the kitchen by hand; sweeps stream into the embodied map; registration and discovery run on real returns for the first time | the basin and a plate appear in the discovered world from real data |
| **S5 Configure the autopilot.** Frame type, rangefinders as altitude source, flow, battery and RC failsafes → land, geofence = the mapped room, prop guards on | a failsafe test with the props off |
| **S6 Tethered hover.** On the pad, 1 m tether, 30 s hover, log IMU and flow drift against the LiDAR registration | drift within the budget of §1 or the budget is rewritten (B13) |
| **S7 First climb.** Takeoff on the pad column, hover at 1.9 m, one sweep, land; pad fix observed | the belief snaps to the truth on landing |
| **S8 One leg.** Takeoff, 2 m leg, registration sweep, return, land, person holding the abort | registration converges on every sweep |
| **S9 The explore plan.** Drone-first exploration exactly as the sim runs it | the discovered world matches the room you can see |

## 9. Safety, in one paragraph

This is a class 1 node (ADR-151) but it is spinning blades at face height in a kitchen. Guards are not
optional. The radio kill switch is the hardware e-stop; the swarm's abort lands regardless of the
map; the geofence is the room; low battery lands. No autonomous flight with anyone within two metres
of the pad column until S8 has been repeated ten times without a registration loss.

## 10. What is deliberately not in v1

- Charging on the pad (contacts in the pad plate are a v2 print).
- Payload. This drone carries sensors; the hands are the arm.
- Outdoor anything. No GPS, no wind model, 12 m sensors.
- Gimballed camera; the pictures the sim renders come from a fixed nadir camera here.
- A second drone. The swarm supports it (fleet mission in the `drone` package); this design does not need it yet.
