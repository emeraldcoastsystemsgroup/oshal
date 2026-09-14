# ADR-154: A local electromechanical lab — circuits, motors and gear trains in one SPICE solve (the Circuit Lab package)

**Status:** Accepted — **BUILT** 2026-09-13 as the store package `circuit-lab` 0.1.0
(`emeraldcoastsystemsgroup/oshal-applications`, `circuit-lab/`). Nothing in core changed; this
ADR records the decision because it settles what "a circuit simulator" means on this platform,
how it relates to the physics lab of ADR-152, and why motors and gears solve inside the circuit
rather than beside it.
**Related:** [ADR-152](152-embodied-physics-and-training-lab.md) (the rigid-body physics lab;
its parts model is where a motor's nameplate should eventually live once),
[ADR-153](153-iterative-cad-kernel-cad-studio.md) (the package-owned engine container and the
"the bot edits a list, the engine does the physics" shape this reuses),
[ADR-036](036-bot-owned-application-architecture.md), [ADR-085](085-remote-app-packages-and-registries.md),
[ADR-149](149-enterprise-application-authorization.md) (route-backed tools under the caller's
authority).

## Context

Operator direction (2026-09-13): a hosted product (Tinkered.ai — a browser breadboard with SPICE
simulation, microcontrollers and AI circuit generation) shows *"a different kind of simulation"*
from the physics environment being built under ADR-152; the operator wants it **localized** so
ideas can be *"used and tested visibly"*, and asked whether it can **include gears and motors**.
Three constraints follow:

1. **Local.** The solve runs on the box, in a package, with nothing leaving it — the same
   posture as CAD Studio's kernel.
2. **Visible.** A schematic a person edits, waveforms, and mechanisms that *move* from the solved
   numbers — not a table of results.
3. **Electromechanical.** A DC motor driven by the circuit turning a gear train with real loads,
   so the question a maker actually has ("will this driver, battery and gearbox move this load?")
   is answered by one run.

What existed: ADR-153's package-owned engine container, hello-verified bridge and route-backed
tool pattern; ADR-152's MuJoCo plant (rigid-body dynamics in 3-D, the wrong tool for a lumped
circuit); the framework's inline concierge and tool bridge.

## Decision

### The solver — cost / benefit

| Option | What it gives | What it costs | Verdict |
|---|---|---|---|
| **ngspice in a package-owned container** | a real SPICE engine (transient, models for diodes / BJTs / MOSFETs / switches, behavioural sources), Debian package, BSD-licensed, ~60 MB | a container per box (one install command); decks are text, so a contract layer must be written | **Chosen** — the same class of solver the hosted product runs |
| CircuitJS1 embedded (Falstad, GPL v2+) | a proven interactive canvas with its own solver | a 2 MB compiled GWT blob to vendor; its model is the canvas, not a contract a bot can edit; GPL-only combination | rejected for the model; the canvas is ours |
| Write our own solver | no container | a nodal solver with device models is months of work and would never match SPICE's | rejected |
| A cloud simulator API | no install | credentials, egress of every circuit, no determinism | rejected: not local |

### The model

- A **design** is `{ parts[], wires[], sim }`; a **run** is one successful solve with the exact
  circuit, the report and the engine build hash — every run is kept, waveforms on disk.
- The **contract** — sixteen part types (ground, junction, battery, signal source, resistor,
  potentiometer, capacitor, inductor, diode, LED, switch with a toggle time, NPN, N-MOSFET, DC
  motor, gear, load), each pin with a **kind** (electrical, shaft, teeth), every property with
  unit, default and range — lives twice (`engine/circuit_parts.py`, `src-routes/circuit-contract.ts`)
  and a spec diffs the two. Routes validate before the solver runs; a refusal names the field.
- **A wire joins two pins of one kind.** Electrical wires form nets; `shaft` wires couple parts
  rigidly; `teeth` wires mesh two gears. That one rule is what lets the mechanism live on the
  same canvas as the circuit.
- **Every current is measured, not derived:** a zero-volt sense source in series with every
  part, so readings and waveforms are what the solver computed.

### Motors and gears inside the solve (the answer to "can it include gears and motors")

A brushed DC motor is identified from nameplate numbers (`nominalVolts, stallAmps, noLoadRpm,
noLoadAmps` → `R, Ke, Kt, b`) and modelled as `R + L +` back-EMF. Its shaft is a **rotational
node** in the same deck through the electromechanical analogy — torque is current, speed is
voltage, inertia is capacitance, viscous friction is conductance, coulomb friction a behavioural
source opposing motion. The **gear train is solved before the deck is written**: shaft groups,
meshes as signed ratios (external gears reverse), every driven shaft's ratio to its motor, and
the whole train **reflected onto the motor shaft** (`J_eq = J + Σ r²J_g`, `b_eq = b + Σ r²b_g`,
`τ_eq = Σ |r| τ_g` — exact for rigid gears). One motor per train; an inconsistent loop or two
gears meshing on one shaft is a refusal. The run reports every shaft's rpm as a signal and the
canvas turns each gear by the integrated speed. No co-simulation loop is needed for rigid trains;
it becomes necessary only for the non-rigid mechanics the package backlog lists (B5).

### The engine and how the swarm drives it

The ADR-153 shape, unchanged: own compose project, stack network, no host port, read-only,
non-root; one persistent hello-verified connection per api process; `capability_unavailable`
with the install command for a stale or absent container. Ten route-backed tools (capabilities,
list, read, create, add / update / remove part, connect / disconnect, run) executed under the
caller's identity by the inline concierge (`circuit-lab-engineer`) and the framework's tool
bridge; writes are `auto` because every write is owner-scoped and every solve is kept.

### What is deliberately not here

No microcontroller firmware (the hosted product's Arduino sketches — package BACKLOG B1, an
avr8js co-simulation step), no breadboard view (B2), no gear hand-off to CAD Studio (B3), no
shared parts model with ADR-152 yet (B4), no belts / springs / linkages (B5), no servo /
stepper / 555 (B6), no convergence retry (B7). The operator's list of external tools to
evaluate (Onshape, McMaster-Carr, WebPlotDigitizer, SimScale, EES, OpenRocket, ParaView,
OpenFOAM, NASA GMAT, NASA CEA) is recorded in the package backlog as evaluation questions with
done-when criteria, not as plans.

## Consequences

**Positive.** A maker's question is answered locally by a real solver, visibly: the LED's
brightness, the resistor's dissipation, the battery's runtime, the motor's spin-up and stall,
the gearbox output speed — in one run, on one canvas, with a bot that edits the same circuit.
The rigid-train reflection keeps the solve a single SPICE transient (tens of milliseconds), so
"run after every edit" is affordable. The whole thing is a store package; core is untouched.

**Negative.** Another engine container per box (one install command; the page nags until it is
run). Rigid gears only — backlash and compliance are not modelled. Two copies of the contract
must be kept in step (a spec enforces it). A hard-switching deck can still fail to converge and
the lab says so rather than retrying.

**As built, 0.2.0 (2026-09-13, same day).** Eight more parts as real elements — zener, lamp, a
behavioural linear regulator, a rail-limited op-amp with a dominant pole, a relay whose contacts
follow the coil current with hysteresis, a sequenced pin (a repeating PWL source — the stand-in for
a programmed pin until firmware is in the loop), an H-bridge driver as four switches with a dead
band, and a 555 as a hysteresis latch on the real 1/3 and 2/3 Vcc thresholds (solved at the formula
frequency of an astable). One lesson worth recording: a hard step inside a behavioural source
stalls ngspice's timestep control; comparators are `tanh`, never a ternary. A refused deck is
retried once with relaxed tolerances and the run says so. Restore any kept run (undo), and the
gear-to-CAD-Studio hand-off: an involute outline posted as a `sketch` base with a bore, validated
against CAD Studio's own contract by a cross-package spec. The canvas gained drag-from-palette,
undo / redo, copy / paste, wheel zoom, shift-drag pan and live values at the timeline's time.

**As built, 0.3.0 (2026-09-13, same day).** Servo and stepper as real elements on the same
shaft-node analogy — a hobby servo whose pulse width is sampled in the deck by a ramp / hold pair
at each falling edge and whose position loop drives a geared DC motor from the supply it is wired
to (it goes to the angle its pulse names at its rated speed, droops under a torque, and does
nothing without a supply); a bipolar stepper with sinusoidal torque and back-EMF against the
rotor angle, detent torque and a capped damping term, behind a step/dir driver that counts edges
with a charge packet and holds sine / cosine phase currents with a saturating regulator (one step
per pulse exactly; a weight held at the textbook load angle `asin(τ / Km·I)`; steps lost above
pull-out, reported). A load's constant torque (a lifted weight) reflects through the *signed*
ratio — the test that first assumed the other sign found the mesh reversal. Any of motor, servo,
stepper drives a train. B4's half that belongs to this package: a shaft-driver catalog whose
nameplates validate against the contract, with a source line per number and a read-only
cross-package test that fails when embodied's motor name, mass or price drifts; the embodied half
(reading the rows by id) belongs to that package. B9 closed on the canvas — marquee multi-select
with group move, wire re-routing saved on the wire, click-a-wire-to-plot — each with a browser
case. The operator's external-tool list evaluated: ten dated notes under the package's
`docs/evaluations/` (evidence fetched that day, cost / benefit, a BACKLOG item with done-when or
a recorded no: Onshape and McMaster-Carr as connectors later, an equation lab in place of EES, a
rocket lane for OpenRocket + CEA, ParaView once a field exists, OpenFOAM and GMAT as benchmarks
in aero-lab and sat-ops, WebPlotDigitizer and SimScale no). Lesson recorded: a stepper's step
counter must integrate a bounded charge, not a differentiated edge — the edge integral drifted
1.5 % per step under timestep control; and a stepper's "final" numbers must be the last sample,
because a step inside the 2 % averaging window blurs them.

**As built, 0.4.0 (2026-09-14).** The breadboard view (B2): a design may carry a `board` — every
electrical part on a full-size breadboard with its footprint (DIP-8s across the gap on their real
pinouts), jumpers between holes — beside the schematic, and the two are held to one invariant:
they imply the same net partition, hence the same deck. The model is one plain-JS file loaded by
the browser and the routes alike; the routes lay a board out from the schematic, derive the
schematic's electrical wires from an edited board (a wire that still joins one net keeps its id),
and reconcile a saved board after every schematic edit (placements kept, jumpers regenerated). The
proof is the partition equality on every starter example both ways in plain node, the route suite,
and the actual page in Chromium (a layout, a move, a jumper). Migration 002 adds the column.

**As built, 0.5.0 (2026-09-14).** Non-rigid mechanics (B5) without a co-simulation layer: the
mechanism solver now produces *clusters* of rigidly meshed shaft groups, one rotational node each
(driven or passive), joined by *compliant links* — a torsion spring (a twist integrator with a
stiffness and a damping torque between two nodes), a belt between two pulleys (a saturating
viscous coupling of the rim speeds that creeps under load and slips at the grip), and a
crank-slider whose slider mass, damper, spring and friction act on its node through the exact
crank kinematics, making the node's inertia position-dependent (every torque summed on a torque
node, a unit capacitor integrating the quotient). The real solver checks a spring and a load
ringing at `sqrt(k/J)/2π`, a belt at the radius ratio then slipping at its grip, and the slider
following `x(θ)` within 0.05 mm over two revolutions with a stroke of `2r`. The Planck.js
co-simulation the backlog had sketched was not needed for these mechanisms and was not built;
a general 2-D linkage layer stays open with its own done-when. A fifth starter, the belt-driven
crank-slider, puts the whole chain on one canvas.

**As built, 0.5.1 (2026-09-14).** A hotfix with a lesson: the framework's Test Lab catalog loader
refuses a WHOLE manifest when any `expected` line exceeds 500 characters (0.5.0's engine-solver
case carried one of 568), and a refused manifest leaves the app unmounted on the box while the
store row keeps the old version — the failure is silent from the page. The lines were split, and
the framework-coupled route suite now loads the package's own catalog through the framework's
loader (`scripts/oshal-test-catalog.js`) so the limit is a red test, not a dead tile.

**0.6.0 (2026-09-14) — on the store branch, NOT installed; real-solver run pending.** Firmware in the
loop, the OUTPUT half of B1: an `arduino` part
(an Uno — 5V, GND, D2–D13, A0–A5) carries a `sketch`; the worker compiles it for the ATmega328P
with Debian's `gcc-avr` against the Arduino AVR core (precompiled into a `core.a` at image build)
and runs the HEX in `avr8js` (MIT, the npm tarball pinned by sha512 in the Dockerfile) for the
transient, at most 10 s, timers 0/1/2 and the USART live so `delay`, `millis`, `analogWrite` and
`Serial` behave; every OUTPUT pin's edges become a PWL source through 25 Ω in the same deck (INPUT
pins are loads, INPUT_PULLUP a 35 kΩ to the rail, the 5V pin a sensed rail). A sketch that does not
compile is refused naming `parts[i].props.sketch` with the compiler's words; a board whose GND is
unwired warns. The sketch cannot read the circuit back — `digitalRead` / `analogRead` see the
AVR's defaults — and that INPUT half stays in the package BACKLOG with its done-when (a per-tick
co-simulation through `libngspice`, which Debian bookworm carries at the same version). The engine
image grows by the toolchain (about 250 MB downloaded on the first build); the firmware runner
files join the build hash so an api and an engine of different vintages refuse each other. Also in
0.6.0, the assistant: the manifest declares the surface-bridge ops (`context`, `custom`, `notify` —
the cockpit relay is fail-closed without them) and the page publishes what it shows (the open
design's parts, wires, readings, warnings and selection as a capped digest) on every open, save,
run, selection and view change; Jarvis edits through one custom op, `circuit_action`, whose
description is the ten-action vocabulary, applied through the routes the canvas already uses with
one solve at the end; and the concierge runs in `jarvisMode: delegate`, so a circuit question in
the chat gets the design's numbers from its tools rather than a link to the tile. No core code
changed for any of it. Verified on a host checkout: the six plain-node suites, the 11-case HTTP
suite and the 11-case Chromium suite (the rail through the real bridge client). NOT yet run: the
39-case real-solver suite and the installer self-test inside the rebuilt engine image — the
reference box's Docker daemon dropped the build session under load after every Dockerfile step
had completed; the package's `docs/continuing-0.6.0.md` is the hand-over. The box runs 0.5.1.

**Verification shipped with it.** The real-solver Python suite (17 cases at 0.1.0, 26 at 0.2.0, 32 at 0.3.0, 36 at 0.5.0, 39 written for 0.6.0 — the four firmware cases unrun as of 2026-09-14, in the engine image and
the installer's self-test: LED, RC, switch mid-run, geared motor, stalled motor, PWM through a
MOSFET, mechanism refusals, protocol, a blink sketch's LED at the sketch period with its serial
captured, `analogWrite`'s RC average at the duty, a sketch that does not compile refused naming
it), the contract suite (Node ≡ Python library and build hash)
and the transport suite against a fake bridge (plain node, store-ci), the gear-to-CAD suite
(plain node, read-only cross-package), the driver-catalog suite (plain node, read-only cross-package against embodied's parts model),
the breadboard-model suite and the assistant-rail suite (plain node — the manifest's surface
ops, the vocabulary under the contract's 600-character cap, the digest under 4,000 characters on
a 200-part circuit), the framework-coupled HTTP suite with the real engine client (9 cases, 11 at
0.6.0 — the catalog through the framework's own loader) and the actual-page Chromium suite (5
cases at 0.2.0, 8 at 0.3.0, 11 at 0.6.0 — the sketch edits as multi-line text and is saved
intact; the rail through the real bridge client), all registered in the Test Lab with their
prerequisites.
