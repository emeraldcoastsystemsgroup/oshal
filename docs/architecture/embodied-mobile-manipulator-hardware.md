# Mobile manipulator hardware: the base, the balance problem, and the build

**Status:** design (2026-09-12). Companion to [ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md).
Nothing here is built. Every price and vendor figure is **indicative, to be verified at order
time**; every mass in the stability budget is a **design assumption until weighed at bring-up**
(stage S6 below), and the node's capability manifest must publish the measured values, never
these.

The software side is already settled by ADR-151 and the sim is acceptable as the first target.
This document is the part that needs the hard thinking: a six-foot arm that **rolls around a
house** and exerts real force without falling over, built from parts you can actually order.

## 1. What the machine has to do, in numbers

| Requirement | Number used for design | Where it comes from |
|---|---|---|
| Reach a dish on a counter, a fridge shelf, a low rack | tool centre point (TCP) from ~0.05 m to ~1.7 m above the floor | counters 0.9 m, fridge top shelf 1.3–1.5 m, freezer top 1.7 m |
| Open a refrigerator door | horizontal pull up to **60 N** at a handle **1.1 m** high | magnetic gasket break-away is typically 20–60 N; design to the top |
| Carry a dish | **2 kg** payload at full reach | plates, bowls, a full mug |
| Fit through interior doors | lateral width **≤ 0.60 m** | a 28-inch door is 0.71 m |
| Cross thresholds and rugs | step **≥ 20 mm** | interior thresholds ~13 mm, exterior up to 25 mm, rug edges 10–15 mm |
| Not fall over | tipping factor **≥ 2** on the worst static case; never tip on a dead stop at rated speed | §3 |
| Never drop the arm on power loss | lift holds rated load unpowered for an hour without drift | §4.3, S5 |
| Run a useful session | **≥ 3 h** at average load | §5 |

## 2. The three decisions that settle the balance problem

Everything else is detail. These three are the design.

### 2.1 A statically stable base with the mass at the bottom — not a balancing robot

A two-wheel inverted-pendulum base (Segway / ballbot style) is elegant and would make the
machine narrower, and it is the wrong answer for a kinetic device in a home: it **falls when
power or control is lost**, and every arm motion becomes a disturbance the controller has to
fight. A statically stable base fails to a stop. The battery is the ballast and it sits on the
floor of the base; the arm's weight is the enemy and it lives as low as possible whenever the
machine is moving (§2.3).

### 2.2 Differential drive on large hub motors, casters at the corners — not 5-inch wheels, not mecanum

**Wheel size.** A driven rigid wheel climbs a step of roughly a third of its radius; an
unpowered caster manages about a quarter of its own. That rules the choice:

| Drive wheel | Radius | Step a driven wheel clears (~R/3) | Verdict |
|---|---|---|---|
| 5 in (127 mm) solid rubber | 64 mm | ~21 mm | marginal on exterior thresholds; the *casters* you would pair with it (3–4 in) fail on interior ones |
| 6.5 in hoverboard hub motor | 83 mm | ~27 mm | workable; cheapest competent motor; coarse hall odometry |
| **8.5 in scooter hub motor** (Xiaomi M365 class, 36 V 250–350 W) | 108 mm | ~36 mm | **recommended**: solid "honeycomb" tyre, non-marking, cheap, everywhere |
| 10 in scooter hub motor (Ninebot Max class, 36 V 350 W) | 127 mm | ~42 mm | best on thresholds; 2 cm more base height |

Your 5-inch instinct was right about *rubber* (grip on wood and tile, quiet, non-marking) and
wrong about *size*. Go to 8.5 or 10 inch **hub motors**: the motor is inside the wheel, so there
is no gearbox, belt, or axle alignment to build, and the scooter industry has made them cheap.
Run them at 24 V (torque is current-limited, so only top speed drops, to about 4 m/s — far
above the 0.8 m/s this machine will ever be allowed).

**Casters.** Four swivel casters at the **corners**, 5 inch, soft thermoplastic-rubber tread,
**spring-loaded**. Corners matter: two casters on the centreline give a diamond-shaped support
polygon that is narrow exactly where the arm goes out to the side; four corners give the full
rectangle. Spring preload is set so the two drive wheels carry 55–60 % of the weight (measured
on a bathroom scale at S2) — that is what keeps traction when a caster drops into a rug edge.

**Drive layout.** Two hub motors on a common lateral axis at the footprint's longitudinal
midpoint; differential drive. Mecanum wheels were considered and rejected: they vibrate, slip
on rugs, and cannot cross thresholds; the arm has six degrees of freedom and absorbs the
alignment error a non-holonomic base leaves. Every mobile manipulator that works in homes
today (Stretch, TIAGo, Fetch, HSR) made the same call.

### 2.3 Move low, rise to work, brace before force

The arm is mounted on a **vertical lift** on the column, not fixed at the top. Driving happens
with the carriage at the bottom of its travel and the arm folded: the combined centre of mass
sits at about 0.4 m. The lift raises the arm only when the base is parked at the work. Before
the arm applies a force, the software checks the **tip budget** (§3.3) for the current pose,
payload and direction, and refuses or re-orients the base if it is short. Outriggers (§4.6)
are the optional second line, not the first.

## 3. The stability budget

### 3.1 Mass model (design assumptions — weigh at S6 and replace)

Footprint **0.65 m (fore–aft, the work axis) × 0.55 m (lateral)**; casters inset 30 mm from
the corners, so the support polygon is **0.59 × 0.49 m**, half-widths **0.295 m** fore–aft and
**0.245 m** lateral.

| Sub-assembly | Mass | Height of its centre of mass |
|---|---|---|
| Base frame, deck, skirt, casters, bumpers | 14 kg | 0.15 m |
| Two hub motors | 7 kg | 0.13 m |
| Battery (24 V 50 Ah LiFePO4) | 12 kg | 0.10 m |
| Electronics (compute, drives, converters, wiring) | 4 kg | 0.25 m |
| Column, lift, carriage plate | 12 kg | 0.80 m |
| Arm + gripper + force sensor + wrist camera | 13.6 kg | 0.50 m stowed / 1.20 m working |
| Head (mast, depth camera, LED, speaker) | 2.5 kg | 1.55 m |
| **Total (no payload)** | **65 kg** | **0.39 m stowed / 0.54 m working** |

With 2 kg of payload held at full reach the working centre of mass is at 0.56 m and shifts
**0.09 m horizontally** toward the work (arm links at about half reach, payload at 0.7 m).

### 3.2 Static tipping — the fridge door

Pulling a door toward the robot pulls the robot toward the fridge; the tipping edge is the
**front** caster line and the arm's reach shifts the centre of mass the same way. Worst case,
both together:

- Stabilising moment about the front edge: 67 kg × 9.81 m/s² × (0.295 − 0.092) m ≈ **134 N·m**
- Tipping moment from the pull: 60 N × 1.1 m = **66 N·m**
- **Factor ≈ 2.0** facing the work. Sideways (base not aligned, arm out over the 0.245 m
  half-width): ≈ 101 N·m, **factor 1.5** — acceptable but not comfortable, which is why the
  planner requires the base to face the work within ±20° before any force task.

Pushing (a drawer, a door closing) tips backward, where the arm's shift *helps*; it is never
the limiting case.

### 3.3 Dynamic tipping — the dead stop

A wall or a bumper hit is effectively instantaneous, so compare kinetic energy with the energy
needed to lift the centre of mass over the tipping edge, `m·g·(√(d²+h²) − h)`:

| State | Energy to tip forward | Kinetic energy at the speed limit | Margin |
|---|---|---|---|
| Stowed (h 0.39 m, d 0.295 m) | ≈ 63 J | 0.8 m/s → 21 J | 3× |
| Arm up and extended (h 0.56 m, d 0.203 m) | ≈ 24 J | 0.3 m/s → 3 J | 8× |
| Arm up and extended | ≈ 24 J | 0.5 m/s → 8 J | 2.8× |

Hence the two speed limits the safety microcontroller enforces from the lift position, not the
planner: **0.8 m/s stowed, 0.3 m/s whenever the carriage is above its bottom stop**, with
deceleration ramps capped at 2 m/s².

These four numbers (two moments, two energies) **are the `envelope` of the ADR-151 capability
manifest**, computed live from the measured masses, the lift encoder, the arm's joint state and
the estimated payload from the wrist force sensor. The sim provider carries exactly this model —
rigid masses, a support polygon, a tip budget — and refuses any skill whose expected wrench
exceeds it. No physics engine is needed for that, and nothing in it has a seed.

## 4. Parts

Vendor and model names are real products at the time of writing; confirm specifications and
prices before ordering. Where a figure is uncertain it says so.

### 4.1 Arm, gripper, wrist

| Part | Choice | Why | Indicative |
|---|---|---|---|
| Arm | **UFactory xArm 6** — 6 DOF, 0.7 m reach, 5 kg payload, 12.2 kg, **24 V DC**, ROS 2 + Python SDK, joint brakes, current-based collision detection | the only mid-price collaborative arm in this class that runs natively from a 24 V battery bus; order the **DC-input control-box variant UFactory sells for AGV/AMR mounting** (confirm with vendor) | ~$11k |
| Alternative arms | UR5e (0.85 m, 5 kg, 20.6 kg) needs 100–240 V AC — an inverter on a battery robot; Kinova Gen3 (7 DOF, 24 V, 0.9 m, 4 kg, 8.2 kg) is purpose-built for mobile and costs roughly three times more; AgileX Piper (6 DOF, 24 V, 1.5 kg payload, ~$2.5k) carries a dish but **not** a fridge door | | |
| Gripper | vendor parallel gripper (≥ 80 mm stroke, force-limited) or **Robotiq 2F-85** (85 mm, 20–235 N, 0.9 kg, RS-485) | a plate rim is 5–10 mm, a fridge handle bar 25–40 mm; 85 mm covers both | $1k / ~$5k |
| Wrist force/torque | vendor 6-axis FT sensor for the arm | opening a door needs compliance (admittance control) and a payload estimate for the tip budget; joint-current sensing is the fallback, not the plan | ~$1.5k |
| Wrist camera | Intel RealSense **D405** (7–50 cm) | grasp-range depth | ~$300 |

### 4.2 Base drivetrain

| Part | Choice | Indicative |
|---|---|---|
| Drive wheels | 2 × 8.5 in (or 10 in) 36 V 350 W scooter hub motors, **solid** non-marking tyre, hall sensors | ~$200 |
| Motor drives | 2 × **ODrive S1** (12–50 V, FOC, hall + optional encoder, CAN) — or one dual hoverboard mainboard reflashed with the open FOC firmware as the bargain path | ~$300 |
| Casters | 4 × 5 in swivel, TPR tread, spring-loaded (shock-absorbing cart casters), bolt-plate mount | ~$120 |
| Motor mounts | 10 mm aluminium plates with a D-slot for the hub axle flats, bolted to the frame | machined or CNC-cut |

### 4.3 Column and lift

Two honest options; pick one.

| | A — electric desk lifting column | B — linear rail + ball screw |
|---|---|---|
| What | two-stage 24 V lifting column (LINAK DL-series / TiMOTION TL-series class), 600–700 mm stroke, ≥ 800 N | 2 × HGR20 profile rails (1.0 m) + SFU1605 ball screw (0.9 m) + NEMA 34 closed-loop stepper **with brake** |
| Holds unpowered | yes by construction (lead screw / worm) — built to hold a desk | **no**; the brake or a ~150 N gas-spring counterbalance is mandatory |
| Position feedback | usually hidden inside the vendor controller → add an external magnetic-strip or draw-wire encoder | native, sub-millimetre |
| Speed | ~40 mm/s, 10 % duty cycle (fine for a few moves per task) | ~80 mm/s, continuous |
| Lateral moment | rated for a desk top — good | rails carry moment well; the screw does not — keep the load on the carriages |
| Cost | ~$300 | ~$700 |
| Recommendation | **v1** — the unpowered hold is the safety property | when precision or duty cycle bites |

Carriage plate 10 mm aluminium; arm mounts on the vendor's flange pattern. Travel 0.30–1.00 m
above the floor.

### 4.4 Power — one 24 V bus

| Part | Choice | Indicative |
|---|---|---|
| Battery | **24 V (8S) LiFePO4 50 Ah**, integrated 100 A BMS, ~1.3 kWh, ~12 kg — the ballast | ~$350 |
| Charger | 29.2 V 20 A LiFePO4 charger; plug-in for v1, dock later | ~$80 |
| Main protection | 80 A MIDI fuse → 24 V 100 A contactor (the e-stop chain drives its coil) → bus bars | ~$100 |
| Branch fuses | arm 25 A, each motor drive 30 A, lift 10 A, compute 10 A | |
| Converters | 24→12 V 10 A for compute and sensors; 24→5 V 5 A for logic | ~$100 |
| Wire | 8 AWG main bus, 12 AWG branches, Anderson SB50 at the battery | |

Power budget: arm 150 W average (400 W peak), drive 60–100 W cruising (700 W peak), lift 150 W
at low duty, compute and sensors 50 W → **~300 W average**, so 1.3 kWh at 80 % depth of
discharge gives about **3.5 h**.

### 4.5 Compute, sensing, safety electronics

| Part | Choice | Role |
|---|---|---|
| Main computer | **NVIDIA Jetson Orin NX 16 GB** on a carrier (Seeed reComputer J4012 class) | ROS 2, arm driver, navigation, perception, the oshal peripheral node |
| Safety microcontroller | **Teensy 4.1** (or an STM32) | bumpers, cliff sensors, IMU tilt, lift limits, e-stop loop state, **10 Hz heartbeat watchdog** from the Jetson; opens the motor-enable relay on any fault |
| IMU | Bosch BNO085 | tilt alarm (> 10° → stop everything) |
| LiDAR | **Livox Mid-360** mounted **inverted at ~0.35 m on the base front** so its +52° cone looks down across the floor — or a Slamtec RPLIDAR S2 as the 2D budget choice | navigation, obstacle avoidance, and a real LiDAR feed into the ADR-150 occupancy grid |
| Head camera | RealSense D435i or D455 on a small pan-tilt at 1.55 m | scene, object localisation |
| Cliff sensors | 4 × IR distance sensors, one ahead of each caster | stairs |
| Bumper | pressure-sensitive tape switch around the skirt | contact stop |
| E-stops | 22 mm mushroom NC on the column at 1.0 m + a wireless NC e-stop fob | the human's two stops |
| Indication | LED strip (state), small speaker | |

**The e-stop chain** is two-channel, normally-closed, and purely electrical: mushroom button →
wireless receiver relay → safety microcontroller relay, in series, driving the 24 V contactor
for **drive and lift power**. The **arm is not stopped by cutting its power**: the same chain
feeds the arm controller's dedicated emergency-stop input so its joint brakes engage under
control. Software never sits in this loop; the heartbeat watchdog only *adds* a way to open it.

### 4.6 Frame and skin

- **4040 T-slot aluminium extrusion** (M8 T-nuts), corner cubes and gussets; base frame
  2 × 650 mm + 2 × 470 mm rails, 4 × 160 mm uprights; deck **6 mm 6061 aluminium**; battery
  tray on the floor of the frame between the motors; skirt panels 3 mm HDPE; ground clearance
  45 mm.
- The column is **two 4080 extrusions** flanking the lift (or the lift column itself as the
  spine when option A is chosen) bolted to the deck through gussets on all four sides — this
  joint carries the whole arm moment, so it is the one place not to skimp on fasteners.
- Optional **outriggers** (deferred): two 12 V linear actuators with rubber feet at the front
  corners, 50 mm stroke, extend the polygon 0.15 m forward when parked → roughly +100 N·m of
  budget (factor 3.5 on the fridge case). Add only if S6 measurements say the margin is thin.

### 4.7 Indicative total

About **$18–19k** with the xArm 6 and a vendor gripper; about **$9k** with an AgileX Piper for a
dish-only machine that does not open doors. Either is a bench figure, not a product cost.

## 5. Geometry at a glance

| Height above floor | What is there |
|---|---|
| 0.00–0.045 m | ground clearance |
| 0.045–0.22 m | base box: battery, hub motors, drives, converters, safety MCU |
| 0.22 m | deck; column foot; LiDAR at 0.35 m on the front face |
| 0.30–1.00 m | lift travel (arm base flange rides here) |
| 1.0 m | mushroom e-stop |
| 1.45 m | column top |
| 1.55–1.70 m | head: pan-tilt camera, LED, speaker |

Folded and lowered it is a 0.65 × 0.55 m box about 1.7 m tall; the TCP reaches from the floor
to about 1.7 m with the carriage at the top and the arm raised.

## 6. Assembly and bring-up

Each stage ends with a gate. Do not start the next stage until the gate passes; record the
measurement — the measured values are what the capability manifest publishes.

**S1 — Base frame.** Cut and deburr the extrusion; assemble the 650 × 550 frame with corner
cubes; check squareness (diagonals equal within 1 mm); drill and fit the deck and the battery
tray. *Gate:* frame square, deck flat, tray holds the battery without movement.

**S2 — Drivetrain.** Fit motor plates at mid-length; clamp the hub motors; fit the four spring
casters; set ground clearance to 45 mm. Push the bare base by hand. *Gate:* rolls straight, no
caster wobble; on a scale, drive wheels carry 55–60 % of the frame weight (adjust caster
preload).

**S3 — Power and the e-stop chain, before any motor is powered.** Battery, main fuse,
contactor, bus bars, branch fuses, converters, grounds. Wire the complete e-stop chain. *Gate:*
with a meter, every e-stop (button, fob, MCU relay) opens the contactor; nothing downstream is
live while any one is open.

**S4 — Motor control.** ODrives, calibration, the safety MCU, bumpers, cliff sensors, IMU. Test
with the wheels off the ground first. Then floor tests at 0.2 m/s with the fob in hand. *Gate:*
e-stop stops the base within 0.1 m; pulling the heartbeat stops it within one cycle; a bumper
press stops it; a cliff sensor over a step stops it.

**S5 — Column and lift.** Bolt the column through the gussets; fit the carriage plate, limit
switches and the position encoder. *Gate:* full travel both ways; **20 kg of dead weight on the
carriage at the top holds for one hour unpowered with no measurable drift**.

**S6 — Tilt test with dead weight, before the arm exists.** Strap 16 kg where the arm will sit,
carriage at the top. With a luggage scale or force gauge pull horizontally at 1.1 m, forward
then sideways. *Gate:* no caster lifts below **80 N forward and 60 N sideways**; weigh every
sub-assembly and record the table in §3.1 with real numbers. If it fails, add ballast or fit
the outriggers — do not proceed to S7 on the hope that software will manage it.

**S7 — Arm.** Mount the arm on the vendor's flange pattern, fit the force sensor, gripper and
wrist camera; wire the arm e-stop input into the chain; power the controller; run the vendor
self-test. Collision sensitivity at maximum, joint speed limited to 30 %. *Gate:* the chain
stops the arm with brakes engaged; a hand on a moving link stops it; the gripper releases on
e-stop reset, never during it.

**S8 — Head and skin.** Mast, pan-tilt camera, LiDAR at the base front, LED and speaker; cable
management along the column; skirt panels. *Gate:* nothing fouls the lift through its travel;
the arm at full reach clears the head.

**S9 — Node bring-up.** Enrol the machine as an owned peripheral node (ADR-114), publish the
capability manifest from the **measured** masses and the S6 forces, and run the sim's tip-budget
model against the real machine: the measured budget must be at least the modelled one.
*Gate:* the first taught task — lift, reach to a marked shelf, grasp a plate, place it — runs
draft → human execute → verify, with every command in the log.

## 7. What is deliberately not in v1

- A self-balancing base (§2.1), mecanum or omni wheels (§2.2), tracks (hardwood).
- Stairs — the cliff sensors stop at them.
- Autonomous docking and charging (plug-in charger first).
- A second arm, a longer arm, or a mobile base that moves *while* the arm works.
- Learned grasping; v1 is taught poses and fiducials (ADR-151 D3/Q5).
