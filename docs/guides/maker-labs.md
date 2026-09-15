# The maker labs — user guide (as-built)

Eight installed apps let you design a thing and look at it: a robot arm, a drone, a printed part, a
circuit, an animatronic prop, a relay chain, an aircraft, a turbine blade. They live on the cockpit's
left ribbon in two groups — **Robotics & Space** and **Engineering** — and each one also opens at its
own `/cockpit/?app=<name>` URL, which is the address to bookmark.

Every lab is **per person**: what you make is scoped to your login and nobody else on the install
sees it. Most of them carry a concierge in the right chat rail that edits the same thing you are
looking at by talking to it.

**Read this first.** Nothing on this shelf drives hardware except Animatronics, and that one only
after you connect a real controller and arm it. The Embodied Swarm lab is a **simulation** — there is
no arm and no drone; every view on it says SIMULATED. Where a lab needs something that is not there
yet — a container to install, a sensor to buy, a decision to make — its section says so.

## Where they are

| Rail tile | Group | URL |
|---|---|---|
| **Embodied Swarm** | Robotics & Space | `/cockpit/?app=embodied` |
| **Animatronics** | Robotics & Space | `/cockpit/?app=animatronics` |
| **Drone Relay** | Robotics & Space | `/cockpit/?app=drone-relay` |
| **CAD Studio** | Engineering | `/cockpit/?app=cad-studio` |
| **Circuit Lab** | Engineering | `/cockpit/?app=circuit-lab` |
| **Scan to Print** | Engineering | `/cockpit/?app=scan-to-print` |
| **Aero Lab** | Engineering | `/cockpit/?app=aero-lab` |
| **Harvest Console** and **Blade Studio** | Engineering | `/cockpit/?app=ocean-lab` |

The rail hover-expands to show the labels; pin it from the toggle at its top-right if you want the
names to stay put. Ocean Lab is one app with two tiles.

---

## Embodied Swarm — the simulated room, the drone that maps it, the arm that works in it

A drone perceives, a six-axis arm on a rolling base acts, you hold command — all of it in a
simulation, so the controls and the integrations are built before a motor turns. The machine starts
knowing **nothing**: the room is hidden, and everything on screen is what its own sensors have built.

**Where:** rail tile **Embodied Swarm**, group **Robotics & Space** — `/cockpit/?app=embodied`.

### Try this first

1. In the header, leave **Room** on *Kitchen* and the truth model on *kinematic truth*, and press
   **Reset world**. The map panel reads "the map is entirely unknown".
2. Press **Explore the room**, tick **drone first (rover parked)**, and confirm. The **Discovered
   world — 3-D** panel fills with mapped voxels as the drone flies frontier to frontier — drag to
   orbit, wheel to zoom. **Pictures** shows what the drone and wrist cameras see, watermarked
   SIMULATED.
3. Read **Discovered surfaces & objects**: `surf-N` and `obj-N` with heights, areas and a guessed
   class. Type a label on one to name it.
4. In **Task**, choose *Clear a discovered surface*, pick **From** and **To** from those discovered
   ids, press **Draft plan**, read the rehearsal verdict, then **Execute** — it asks you to confirm,
   and re-validates every kinetic step against the live map as it runs.
5. Scroll to **Build the drone**. Pick the fit — *Recon-mini* (2-D ring + ToF, the one to print) or
   *Recon-3D* (the 3-D LiDAR fit, held in reserve) — and read the part table: base solid, feature
   count, material, mass each, plus the bought parts underneath. **design as markdown** opens the
   whole design document.
6. Press **Open in CAD Studio** on any printed part. It posts that part's program to CAD Studio and
   opens it there as a real CAD model, with STEP, STL and drawing views.
7. **Build the arm** is the same for the hands: the *Desk-6* arm's joints with what each holds, what
   it needs, what drives it and the margin; **design document** for the write-up; **Open in CAD
   Studio** per printed part.

### Real vs simulated

**Real:** the sensing geometry, the occupancy map, the discovery, the drone's pose estimation and
scan-to-map registration, the kinematics, the stability budget, the guards, the plan shape and the
command log. On the *physics* truth model the MuJoCo engine container flies the printed drone's own
parts model — rigid-body flight at its mass, a cascaded controller, a seeded gust, real contacts with
the room — and **Check on physics** on the arm has the container hold the payload in each joint's
worst pose and report what it measured beside what the design expected.

**Not real:** any hardware. The room is a hidden box scene. The sensors are exact — no noise. On the
kinematic model the drone's drift is a fixed bias per metre, not a measured IMU, and nothing has
inertia. The inertia figures are estimated from where the parts sit. The motor curves are momentum
theory. There is no arm and no drone on a bench anywhere.

### Where the artifacts land

Tasks and the command log are rows in Postgres scoped to you (`embodied_task`,
`embodied_command_log`) and survive a restart. **The world itself is in memory and resets when the
api restarts** — explore again. The drone and arm designs are generated on request, not stored; what
persists from them is whatever you sent to CAD Studio, which then lives as a CAD Studio model.

### What it needs that is not there yet

- The **physics** truth model and the arm's **Check on physics** need the package's engine container
  installed on the box — see [When a lab says its engine is not answering](#when-a-lab-says-its-engine-is-not-answering).
- **No hardware has been bought.** The [buy decision](../architecture/embodied-buy-decision.md) names
  the three things that must be true first: a hand-carried mapping test with the real sensors, a measured
  propeller curve from Aero Lab, and the safety class for a first indoor flight.
- A real arm **cannot join the swarm rail as a node** on a box that requires a person's identity for
  every package call; that is a core decision, recorded in the package's BACKLOG as B20 and B22, not
  something the package can change.

---

## CAD Studio — the real CAD kernel

A part is a **base** plus an **ordered feature list**. Every change replays the list on a real Open
CASCADE kernel and re-exports STEP, STL, four hidden-line drawing views and a measured report. This
is where the robot arm's parts, the drone's parts, a scanned outline and a gear all become actual CAD
drawings you can open, print or send to a shop.

**Where:** rail tile **CAD Studio**, group **Engineering** — `/cockpit/?app=cad-studio`.

### Try this first

1. **New part** — you get a box to start from. (Or arrive here from somewhere else: a part sent from
   Embodied Swarm, a scan's outlines from Scan to Print, a gear from Circuit Lab, or an STL sent
   through *Send to…*.)
2. In the right rail, **Add feature**. The form is generated from the contract the kernel enforces —
   hole, boss, box-add, box-cut, sketch-extrude, revolve, sweep, loft, fillet, chamfer, shell,
   cut-plane, scale, mirror, rotate, translate. Every add, edit, disable, move or remove **rebuilds
   the part and makes a new revision**.
3. A feature the kernel refuses (a fillet radius bigger than the edge allows) is shown **skipped with
   the kernel's reason** and the part stays buildable — fix the number. **Stop rebuild** halts a
   rebuild in flight and leaves the part at its last good revision.
4. Read **Report**: extents, volume, surface area, mass at the density you set, faces / edges /
   vertices / validity, centre of mass. These come from the kernel, not an estimate.
5. Take the drawings. The four views (front, top, right, isometric) render on the page, and the
   download row gives **STEP**, **STL**, **SVG-FRONT**, **SVG-TOP**, **SVG-RIGHT**, **SVG-ISO** and
   **REPORT**.
6. Or just talk to the designer in the chat rail — "put a 6 mm hole 10 mm from the left edge and
   round the vertical edges 2 mm". It calls the same tools and the studio refreshes as it works.
   **Revisions → Restore** undoes anything.

The frame is millimetres, right-handed, Z up; the footprint is centred on X = Y = 0, the part rests
on Z = 0, the front faces −Y. Same base plus same feature list gives the same STEP and STL bytes.

### Real vs simulated

Real geometry from a real kernel. The report's numbers are measured off the solid. What the studio
does **not** do is manufacturing acceptance — a valid solid is not a certified print or a machinable
part.

### Where the artifacts land

Models and revisions are rows in Postgres scoped to you. The exported files sit under the shared
workspace at `<workspace>/cad-studio/<hash of your id>/<model>/<revision>/` (override with
`CAD_STUDIO_DATA_DIR`), and the page's download links serve them per revision.

### What it needs that is not there yet

The kernel runs in the package's own container. Without it the studio shows "The CAD engine container
is not answering." and prints the install command — see below. Printing is not here: download the STL
and send it from Scan to Print.

---

## Circuit Lab — circuits and mechanisms in one solve

Parts and wires on a schematic canvas, solved by a real SPICE engine (ngspice) every time the circuit
changes. Motors and gear trains are part of the **same solve** — a motor's shaft is a rotational
node, gears reflect their loads onto it, and the gears turn on the canvas at their solved speed.

**Where:** rail tile **Circuit Lab**, group **Engineering** — `/cockpit/?app=circuit-lab`.

### Try this first

1. **Start from an example…** and pick *a motor with a 3:1 gearbox* (the others are a switched LED,
   an RC charge and a PWM motor drive).
2. Press **Run**. The timeline plays the run: gears and rotors turn, LEDs glow with their current, a
   switch flips at its time.
3. Read **Readings** — the solver's numbers per part: currents, powers, LED brightness, battery
   runtime, motor rpm / torque / efficiency / stall, every shaft's rpm — and the warnings beside them
   (an unconnected pin, a resistor over its rating, a stalled motor, a gear nothing drives).
   **Waveforms**, the deck (`.cir`) and the report are downloads.
4. Build your own: drag a part from the palette onto the canvas, click one pin then another to wire
   them, select a part to edit its properties in the right rail. `R` rotates, `Delete` removes,
   `Ctrl+Z` / `Ctrl+Y` undo and redo, the wheel zooms.
5. **Breadboard** shows the same circuit laid out on a full-size board, drawn to scale — drag parts
   to other holes, click hole to hole for a jumper, and the schematic's wires follow. A part whose
   own legs share a strip is named as shorted.
6. Select a gear and press **Open in CAD Studio**: its involute outline becomes a printable part in
   CAD Studio.

An Arduino Uno is a part like any other — its sketch is compiled with avr-gcc and run in avr8js, and
its output pins drive the circuit in the same transient.

### Real vs simulated

Real solver, real numbers, lumped models. A brushless motor is solved as its DC equivalent behind an
ESC, and the catalog says which of its nameplate numbers are typical rather than measured. There is
no heat model and no general 2-D linkage layer beyond the crank-slider. A deck the solver refuses at
the defaults is retried once with relaxed tolerances and the report says so.

### Where the artifacts land

Designs and runs are rows in Postgres scoped to you; every run is kept and **restore** on any run puts
its circuit back. Waveforms, the SPICE deck and the report are downloaded from the page.

### What it needs that is not there yet

The solver runs in the package's own container — install it if the page says it is not answering.
**A sketch drives the circuit but cannot read it back yet**: `digitalRead` and `analogRead` see the
AVR's defaults.

---

## Animatronics — the motion layer for a prop

A prop is a **rig**: servos with per-channel calibration and software limits, grouped into mechanisms
(an eye gimbal, eyelids, a neck, a jaw, an arm). On top of that sit a pose library and **scenarios** —
timed scripts that move to a pose over a duration with an easing, hold, repeat or run together. The
server compiles a scenario to a 50 Hz frame stream, rehearses it on servos that move no faster than
their rated speed, budgets the power supply, and only then hands the browser the exact lines to
stream to a controller.

**Where:** rail tile **Animatronics**, group **Robotics & Space** — `/cockpit/?app=animatronics`.

### Try this first

1. **New rig** from a template — *Two-axis eyes*, *Six-servo face* or *Talking skull* — each arrives
   with its poses and scenarios.
2. **Jog** the sliders. In design mode they move the drawing, not a servo. **Capture as pose…** saves
   the slider angles under an `UPPER_CASE` name.
3. Open **Scenarios**, edit one (`move`, `hold`, `together`, `run`, `repeat`), **Save scenario**, then
   **Rehearse**. The drawing replays what the rate-limited servos would actually do.
4. Read the **Rehearsal** report: per channel, what the move asked versus what the servo is rated for,
   the lag, whether it settled, and the **Supply budget** verdict (idle, peak-moving, all-stalled — a
   USB port is refused).
5. **Look at**: click a bearing on the pad. The eyes take their share first and fast, the neck follows
   slower, and what neither can reach is reported as the residual.
6. With hardware only: **Connect (Web Serial)** from desktop Chromium, **Arm** (the browser asks, then
   the server asks you to confirm), then **▶ Play**. **E-STOP** turns outputs off on the controller
   first and disarms afterwards; **Disarm** is always allowed.

### Real vs simulated

The pulses, the calibration, the rate limits and the power budget are real and the server owns them.
The rehearsal is **rate-limited tracking, not dynamics** — load, inertia and stall on the servo are
not modelled, and neither are linkage geometry, collisions between mechanisms, sound, or a bus
servo's position readback. Until you arm a connected controller, nothing physical moves.

### Where the artifacts land

Rigs, poses, scenarios and the command log are rows in Postgres scoped to you. Every command —
rehearse, arm, play, jog, disarm — is a logged row with its outcome.

### What it needs that is not there yet

Real hardware: an ESP32 or Arduino driving a PCA9685, servos, and a supply the budget accepts. The
browser side needs desktop Chromium (Web Serial). The firmware sketch is not compiled or run by
anything here. A prop does not enrol as a node on the swarm rail — the same identity-gate decision
that blocks the embodied arm.

---

## Scan to Print — photographs in, a measured mesh and a drawing out

Photograph an object from its six sides (or film it, or import a LiDAR point cloud), enter one ruler
measurement, and get an engineering drawing, a watertight 3D model, and — behind an explicit
confirmation — a print job on your own printer.

**Where:** rail tile **Scan to Print**, group **Engineering** — `/cockpit/?app=scan-to-print`.

### Try this first

1. **New object** and name it.
2. **Add photos** from files and assign each a view — front, top and right are the minimum for a
   solid. On a phone, **Use camera** gives a viewfinder with a framing line per view, and **Record
   six views** counts down through all six. **Import .ply** takes an iPhone/iPad Pro LiDAR capture
   instead and skips the photo logic entirely.
3. Enter at least one measured extent in millimetres (**Width X**, **Depth Y**, **Height Z**) and
   **Save scale**.
4. Choose **Resolution** and **Smoothing**, then **Reconstruct**.
5. Read the report: extents with their provenance (known / derived / assumed), volume, facets, the
   printable verdict, the **print checks** (thinnest wall, steepest overhang against a nozzle and
   layer height) and the warnings. Download STL, OBJ, the third-angle SVG sheet and the report.
6. **Open in CAD Studio →** hands the front / top / right outlines to CAD Studio in world
   millimetres, where they become a real CAD part with holes, fillets and a STEP export.
7. To print: **Register a printer** (label, kind, base URL, API key — OctoPrint, Moonraker/Klipper or
   PrusaLink), then **Send to printer…** and confirm.

### Real vs simulated

The geometry is deterministic — same photos, same ruler number, same bytes — and there is no model in
the geometry path. The honest limits: the photo lane produces the **visual hull**, so cavities,
undercuts and holes that no view sees are filled solid (the depth/LiDAR lane is what recovers them);
photos are assumed square-on, and skew is reported as a residual rather than corrected; an extent no
view shows is assumed equal to the measured one and flagged; the print checks are advice, not a
slicer.

### Where the artifacts land

Jobs, images, printers and submissions are rows in Postgres scoped to you; printer API keys are stored
as owner-key ciphertext, never plaintext. The job files sit under the shared workspace at
`<workspace>/scan-to-print` (override with `SCAN_TO_PRINT_DATA_DIR`).

### What it needs that is not there yet

Your own printer host, registered in the app. G-code slicing needs a slicer command configured on the
deployment (`SCAN_TO_PRINT_SLICER_CMD`); without it, choose **STL (host slices)** and let OctoPrint
slice. The depth-image upload lane is API-only — there is no button for it on the page yet.

---

## Drone Relay — a chain that carries commands past the base radio's reach

Mini drones relaying drone to drone so the tip — the one collecting data — can work beyond the base
station's own radio. The app **designs and rehearses** that chain: it sizes the hop from a link
budget, places the relay slots, counts the spares, then fails relays in a simulated scenario and
reports how long the tip was out of reach.

**Where:** rail tile **Drone Relay**, group **Robotics & Space** — `/cockpit/?app=drone-relay`.

### Try this first

1. **New chain**. Pick a **Transport** (ESP-NOW is the default; the table at the bottom compares them
   all at one hop distance), a **Corridor** length, a **Design margin**, **Relays in the fleet**, the
   tip's data rate and the battery **Endurance**. **Preview** sizes it without saving; **Save** keeps
   it.
2. Read the facts card: design range, hop distance, relays and spares, the margin at the hop,
   end-to-end throughput, how long the farthest relay holds its slot and how many relays the rotation
   needs. An infeasible chain says why.
3. **Add failure** — which drone, at what second — and **Run**. Scrub or **Play** the frames on the
   corridor map: slots dashed, drones coloured by reachability, hops coloured by margin.
4. Read the result: verdict (held / restored / degraded / lost), the tip's outage seconds, when the
   controller detected the gap, when the chain reconnected and was restored, the worst margin, spares
   launched and swaps.
5. **Design write-up** generates the Markdown — budget, chain table, the rules as implemented, the
   last run. **Trace a command to the tip** walks one signed envelope through the chain and shows
   every relay's decision.

### Real vs simulated

The two rules the chain runs on — the on-board rule and the controller's rule — are implemented here
exactly as firmware and the controller will carry them, and the signed envelope is the real protocol.
The ranges come from a log-distance link budget on vendor numbers, each row stating its source: they
size a chain, they do not certify one. The simulation moves drones at constant speeds with a hard
link edge at the modelled zero-margin range — no wind, no antenna pattern, no frame loss below the
edge, no terrain. Its value is comparative.

### Where the artifacts land

Plans are rows in Postgres scoped to you (`drone_relay_plan`). The write-up and the trace are
generated on demand.

### What it needs that is not there yet

**Nothing here flies.** The formation can be drafted as a Drone Ops fleet mission through the API, but
it is returned to you rather than sent — getting it into Drone Ops as a draft is still backlog. The
default path-loss exponent is an air-to-air assumption; the hardware document's open-field range test
is what replaces it before a flight.

---

## Aero Lab — the persistent-flight design lab

Shape a solar-endurance aircraft with real sliders — span, area, aspect ratio, battery mass, cell
efficiency, buoyancy fraction, site, season — run it through a real flight-physics engine, and read
the verdict with plots.

**Where:** rail tile **Aero Lab**, group **Engineering** — `/cockpit/?app=aero-lab`.

### Try this first

Pick one of the **Proven starting points**, adjust the **Design vector** sliders, then **Run Polar**,
**Run 24 h Energy Loop** and **Run Screen**. Read the **Verdict** card against the plots — wing polar,
state-of-charge trace, drag buildup, mass ledger, generation vs load. **Export Build Files** writes
the build package: wing panel STLs, rib and hull-gore DXF, the airfoil dat, a BOM and a build sheet.
There is no chat rail on this tile; **Draft with AI** in the page turns plain language into a design
vector draft, and every number still comes from the engine.

### Real vs simulated, and what is open

The engine is a vendored snapshot of a validated flight simulator and the surface always shows its
fingerprint, so which tree answered is never a guess. Two honest caveats the package states itself:
the low-Reynolds section data is a surrogate model, so single-digit-percent margins are design
guidance rather than flight certification; and the recorded headline energy numbers come from the
*ideal* propulsion path, with the real-chain promotion gate still open in the package's backlog. If no
engine is reachable, every capability reports false and the surface says exactly why nothing ran — it
never fabricates a number.

---

## Ocean Lab — ambient-energy design

Model a machine that runs on flow it does not carry, and size the rotor that feeds it. Two tiles:
**Harvest Console** (marine and ground energy budgets over time, seasonal gap analysis, storage
sizing) and **Blade Studio** (NACA sections, panel-method polars, Cp sweeps, and export of the lofted
blade).

**Where:** rail tiles **Harvest Console** and **Blade Studio**, group **Engineering** —
`/cockpit/?app=ocean-lab`.

### Try this first

In **Harvest Console**, pick a site climate and soil type, set the collector area and load, and read
the budget: mean harvest, minimum store, deepest charge, harvest margin — and the two numbers the app
insists on, `longestGapHours` and `minSocFraction`. An annual surplus is not survival: a design can
harvest nearly twice the energy it spends across a year and still be dead for hundreds of hours.

In **Blade Studio**, choose a NACA 4-digit section, blade count, hub radius, collective pitch and the
operating tip-speed ratio, read the power-coefficient curve, then **Export STL (binary)**, **Export
OBJ**, **Export OpenSCAD** or **Export DXF station drawing**.

### Real vs illustrative

The models are real — harmonic tidal constituents, blade-element momentum theory with tip and hub
loss, a soil-thermal damping model, a Hess-Smith panel method. **The inputs are examples.** Every
site, soil profile and tidal constituent set is an illustrative parameter set, not survey data or
harmonic constants for a real station, and no hardware was built. Nothing is stored: every result is
computed on demand from what you posted, and exports download from the page.

---

## How they connect

Four hand-offs are wired, and each one is a button rather than a download-and-re-upload:

- **Scan → CAD → print.** Scan to Print's **Open in CAD Studio →** sends the front / top / right
  outlines to CAD Studio as a `contours` base, where they become an editable part with a STEP export.
  Printing goes the other way: CAD Studio does not print — download the STL and send it from Scan to
  Print, which talks to your own printer behind a confirmation.
- **Circuit gears → CAD.** Select a gear in Circuit Lab and press **Open in CAD Studio**: its involute
  outline arrives as a printable part.
- **Embodied parts → CAD.** Every printed part of the drone and of the Desk-6 arm has **Open in CAD
  Studio** beside it in the **Build the drone** and **Build the arm** tables. That is how the robot
  arm design becomes actual CAD drawings.
- **Spaces scan → the simulated room.** A room you scanned in Spaces is offered through *Send to…* as
  **Fly it in Embodied**. Accept it and the scan appears in Embodied Swarm's **Room** selector beside
  the built-in Kitchen and Studio, with its solid count; **Reset world** starts the drone in it. A
  scene the engine's bounds refuse is rejected naming the rule it broke.

The general mechanism behind the last one — and behind sending an STL into CAD Studio or an image
into Scan to Print from anywhere — is the platform's **Send to…** registry. How it works and what
always appears in the menu is in [Send to…](./send-to.md).

## When a lab says its engine is not answering

Four labs run their heavy compute in a container the package owns rather than inside the api: **CAD
Studio**, **Circuit Lab**, **Aero Lab**, and **Embodied Swarm** (for its physics truth model and the
arm's **Check on physics** only — the kinematic model needs nothing).

The api checks the container's build hash before the first request, so a container built from an older
version of the package answers with the install command instead of a wrong number. When that happens
the page shows a banner — "The CAD engine container is not answering." or "The circuit engine
container is not answering." — followed by **Install or rebuild it from the host:** and the exact
command. Run it from the host shell, not from inside a container:

```sh
docker exec oshal-local-api sh /app/workspace-shared/deployed-apps/cad-studio/engine/install-engine.sh
```

The banner fills in your own api container name, and the same command with the package name swapped
(`circuit-lab`, `aero-lab`, `embodied`) installs the others. It builds the image locally, starts it on
the stack network under its own compose project with no host port, and **self-tests it** before
reporting ready — the circuit engine solves an LED circuit and a geared motor to known numbers, the
CAD engine builds a part on the real kernel. Re-run the same command whenever a page reports the
engine is out of date.

## What you cannot do yet

Specific, and worth knowing before you go looking for a button that is not there:

- **Nothing on this shelf moves hardware except Animatronics**, and only with a real controller
  connected over Web Serial from desktop Chromium and the rig explicitly armed.
- **Embodied Swarm never touches hardware.** There is no arm, no drone, and nothing has been bought.
  The parts model, the flight and the pick-and-place are all simulated; the conditions that must hold
  before anything is purchased are written down in the package's buy-decision document.
- **Embodied's world is not saved.** It lives in memory per person and resets when the api restarts —
  explore again. Tasks and the command log survive.
- **Drone Relay does not fly anything.** It sizes and rehearses; the fleet-mission draft is returned
  to you rather than sent to Drone Ops.
- **A prop or an arm cannot join the swarm rail as a node.** That is blocked on a core
  application-authorization decision, not on these packages; both record the refusal rather than
  hiding it.
- **Circuit Lab's Arduino sketch drives the circuit but cannot read it back** — `digitalRead` and
  `analogRead` see the AVR's defaults.
- **Scan to Print's photo lane cannot see inside anything.** Cavities and undercuts no view reaches
  are filled solid; the depth and LiDAR lanes are what recover them, and the depth upload has no
  button on the page yet.
- **Aero Lab's headline numbers come from the ideal propulsion path** and the real-chain promotion
  gate is still open; the surface shows the engine fingerprint so you always know which tree answered.
- **Ocean Lab's sites, soils and tides are illustrative parameter sets**, not survey data. No hardware
  was built.
- **Nothing here certifies manufacturing.** A valid solid, a passing print check and a clean solver
  run are design evidence, not a guarantee that a part prints, machines or survives a load.

## If something looks wrong

| What you see | What it means |
|---|---|
| A tile is dimmed with a lock glyph | The app is installed but your login is not provisioned for it. Clicking follows the link to the access page rather than opening a dead frame |
| A lab's page says the engine container is not answering | Run the install command the banner prints — see the section above |
| **Explore the room** does nothing visible for a while | The drone is flying frontier to frontier; the 3-D panel fills as sweeps are integrated. The map starts entirely unknown on purpose |
| A drafted plan is refused with a reason | The planner or the live re-validation rejected a step — unknown space, a keep-out, reach, the tip budget. The reason names which one |
| CAD Studio shows a feature "skipped" | The kernel refused it (a fillet radius larger than the edge allows). The part stays at its last good build — fix the number and it rebuilds |
| Scan to Print's downloads disappeared after an edit | Changing measurements, settings, photos or view assignments retires the old report. **Reconstruct** again |
| The Animatronics rig will not play | It is not armed, or the supply budget refused that motion. Rehearse first — rehearsal never needs arming |

Design rationale for the shelf lives in the ADRs: [ADR-150](../adr/150-deterministic-object-reconstruction-scan-to-print.md)
(Scan to Print), [ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md) and
[ADR-152](../adr/152-embodied-physics-and-training-lab.md) (Embodied Swarm),
[ADR-153](../adr/153-iterative-cad-kernel-cad-studio.md) (CAD Studio),
[ADR-154](../adr/154-local-electromechanical-lab-circuit-lab.md) (Circuit Lab),
[ADR-155](../adr/155-drone-relay-chains.md) (Drone Relay) and
[ADR-156](../adr/156-animatronic-props-as-a-peripheral-kind.md) (Animatronics).
