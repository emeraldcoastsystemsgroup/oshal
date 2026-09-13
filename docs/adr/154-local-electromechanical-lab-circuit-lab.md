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

**Verification shipped with it.** The real-solver Python suite (17 cases in the engine image and
the installer's self-test: LED, RC, switch mid-run, geared motor, stalled motor, PWM through a
MOSFET, mechanism refusals, protocol), the contract suite (Node ≡ Python library and build hash)
and the transport suite against a fake bridge (plain node, store-ci), and the framework-coupled
HTTP suite with the real engine client (8 cases, registered in the Test Lab with its checkout
prerequisite).
