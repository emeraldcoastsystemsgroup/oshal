# ADR-160: A vehicle is a record with a computed stage, and the medium it runs in is a parameter

Date: 2026-09-15
Status: **Proposed — nothing here is built.** No code exists for any decision below. The slices are
listed in "Implementation" and tracked in [BACKLOG](../BACKLOG.md).

Related: [ADR-085](085-remote-app-packages-and-registries.md) (store packages own their domain),
[ADR-036](036-bot-owned-application-architecture.md) (the owner of a domain owns its state),
[ADR-097](097-app-suites-primary-categorization.md) (`ai-engineering` shelf),
[ADR-150](150-deterministic-object-reconstruction-scan-to-print.md) (the stale-output contract this
borrows), [ADR-151](151-eyes-and-hands-embodied-swarm.md) and
[ADR-152](152-embodied-physics-and-training-lab.md) (the `embodied` designer this generalises, and
the MuJoCo plant this parameterises), [ADR-153](153-iterative-cad-kernel-cad-studio.md) (CAD Studio,
the kernel that makes a part real and the transport an object travels through),
[ADR-154](154-local-electromechanical-lab-circuit-lab.md) (Circuit Lab),
[ADR-139](139-artifact-exchange-send-to-registry.md) (Send to…, which is an exchange and not a home).
User-facing companion: [the maker labs guide](../guides/maker-labs.md).

## Context

Operator, 2026-09-15, in two parts. First the shape:

> "with blade studio we had an amphibious vehicle fully specced out and an air vehicle fully specced
> out … based on those specs i want to see the tools we created represent their development stage and
> have a way to actually develop them … we should have a water lab and an aero lab … there were waves
> and energy and fabrication … i see nothing but some boxes and lines."

Then, after reading the shape, the decision that reframes it:

> "we do have a wing creation engine we do have a water lab we do have these virtual environments to
> test micro components and objects generally right so let have them and have them interchangeable i
> should be able to run an airplane in my water module and vice versa and want the boat fall to the
> ground" … "interchangeable physicses and objects".

So there are three things to decide, not one: what a vehicle **is**, what a **medium** is, and what
makes an **object** portable between labs. The three are the same problem at three scales — a thing
that exists in one lab and cannot be moved, changed, or run anywhere else.

### The two vehicles

**The marine explorer is a document.**
[docs/research/autonomous-explorer-design-study.md](../research/autonomous-explorer-design-study.md)
specifies a 300 mm machine completely: body 280 mm, wing span 296 mm deployed, a 2.0 m tether, a
24.1 L float giving 24.7 kg of buoyancy, 11 independently watertight parts, an 11,976-triangle
assembly, a five-row sea-state table (flat / calm / light swell / moderate / rough), an
occurrence-weighted 0.46 knots under way 65 % of the time — 20.4 km/day, 7,444 km/year — and an
endurance bounded by biofouling (30–90 days uncoated, 6–12 months coated with a wiper) and hinge
wear at 5.3 million cycles a year, not by energy. It carries its own "What is not true" section, and
that section includes the sentence that matters here: *"It was built by hand with scripts. That is a
process failure, not a modelling one."* The engines that produced it were carved into the `ocean-lab`
store package under Rule 0c; the **explorer itself was not**. The package's engine tree is
`energy/`, `geometry/`, `ground/`, `marine/`, `rotor-design/` — a grep for "explorer" across its
sources and its surfaces returns nothing. The vehicle has no code anywhere.

**The air vehicle is a folder of frozen output.** `aero-lab/reference-design/` in the store repo
holds the Floater — a 3:1 prolate-spheroid helium hull, 2991.4 × 997.1 mm, a 2.5 m wing at 0.52 m²
and AR 12.0 on a NACA 2412 section, 2272.4 g all-up, cruising 4.00 m/s on 9.18 W — with STLs for the
wing, its two panels, the hull and the 4,176-triangle assembly; rib, airfoil-template and hull-gore
DXFs; a gore SVG whose unroll identity is −0.000 %; a three-view schematic; a mass-ledger BOM, a
sourced-parts BOM carrying real manufacturers, part numbers and prices with an honesty note per line,
and the deltas between them; a build sheet; a design snapshot; and five validator outputs. **These
are generated, not hand-drafted** — `engine/export_build_files.py` writes the whole set from a design
vector, and its own README says so. That correction matters: the air side already has the generator
this ADR is about. What it does not have is a *record*. The folder is one run, committed, and it is
already out of step with its own package: the README states the numbers stand on the ideal propulsion
chain, that the real-chain promotion gate is red, and that real sourced parts came in **274 g
heavier** than the certified ledger, which is why the as-built craft needs a 98.0 Wh pack instead of
the 79.6 Wh the catalogue design assumed. A snapshot cannot tell you it has gone stale. A record can.

**What the labs are today.** `ocean-lab` exposes exactly two surfaces — Harvest Console and Blade
Studio — and neither knows a vehicle exists; Blade Studio is component-level (NACA sections,
panel-method polars, Cp sweeps, blade export). `aero-lab` exposes one. Both own **no tables at all**:
neither package has a `migrations/` directory, nothing is stored, and every result is computed from
what was posted and then discarded. That is the whole diagnosis. The labs are analysis surfaces over
anonymous parameter vectors. There is no object to have a stage, so of course nothing represents one,
and "boxes and lines" is the honest visual consequence of a lab that cannot name the machine it is
drawing.

**The design pattern already exists, shipped, in another package.** `embodied` B16 (DONE 0.6.0) is
`engine/design/`: `propulsion` (momentum-theory sizing), `airframe` (each printed part as a CAD Studio
program — a base plus an ordered feature list in CAD Studio's contract and frame), `parts-model` (two
fits; printed parts with material, print notes and mass; bought parts with mass, role and approximate
price; the mass budget summed from them and the sizing recomputed *at* that mass; print rules; sensor
poses taken from the same sensor set the simulation flies), and `design-markdown` (the hardware
document's tables, generated). It serves `GET /build/drone?fit=`, `/build/drone/parts/:id` — the body
to post to `/api/cad-studio/models` — and `/build/drone/design.md`, behind a **Build the drone** panel
with **Open in CAD Studio** per part. STL and STEP come from the real OCCT kernel, not a mesh writer.
It has already been generalised once inside its own package: `arm-design`, `arm-parts`, `arm-markdown`
and `servos` do the same for the Desk-6 arm. So a machine is a *module*, not a package — that is
settled by working code, and this ADR does not relitigate it.

B16's gap is the one the operator hit. The maker-labs guide states it plainly: *"The drone and arm
designs are generated on request, not stored."* A design you cannot save is a design you cannot
develop.

### What is already true about media, which is more than expected

The second half of the ask sounds like a solver rewrite. It is not, and the codebase says so. Read
before costing it:

- **Aero Lab already has an environment answer-machine.** `aero-lab/engine/aerosim/env/` —
  `atmosphere.py`, `wind.py`, `solar.py` — documents itself as answering, at any (x, y, z, t):
  density, pressure, temperature, viscosity and speed of sound with the mandatory geometric →
  geopotential conversion; an ENU wind **vector together with its analytic vertical gradient**,
  C1-continuous by construction; and sun position and irradiance. It is implemented over
  [−5000, 47000] m and **raises outside that band rather than clamping**, with the reason written
  down: *"the ISA table ends there, and a silently extrapolated density is exactly the kind of
  confident fiction this project exists to keep out of the loop."*
- **The aircraft polar does not assume air.** `aerosim/aeropolar.py` takes `rho_kgm3` and `mu_Pas` as
  explicit arguments and validates them positive (≈ L1083–1145), and the environment feeds them:
  `vehicle/aerosurface.py` `evaluate(…, atmo: AtmoSample, …)` sets `rho_kgm3 = float(atmo.rho_kgm3)`
  and `mu_Pas = float(atmo.mu_Pas)` (L720–721), passes both into `coefficients()` (L504) →
  `_polar_for_bin()` (L417) → `aeropolar.wing_polar(…, rho_kgm3=rho_kgm3, …)` (L447, L460), and then
  computes `dynamic_pressure_Pa = 0.5 * rho_kgm3 * airspeed_ms ** 2` from the same number. Density
  flows from the environment into the force model already. The polar module also carries a "Reynolds
  honesty policy": it returns a number **and a per-point `valid` flag** over a hard band
  `RE_FLOOR = 30_000` to `RE_CEIL = 5.0e6`, and the selector will only ever pick a valid point. That
  is a validity envelope, already implemented, for one axis — and D7 explains why one axis is not
  enough.
- **Ocean Lab's rotor lane does not assume water.** `rotor-types.ts` L69–72 declares
  `densityKgM3` and `kinematicViscosityM2S` on the flow condition; `bemt-solver.ts` uses
  `flow.densityKgM3` in the dynamic-pressure terms (L563, L711) and `flow.kinematicViscosityM2S` for
  section Reynolds; seawater is a **preset default** in `rotor-presets.ts`, not a constant inside the
  solver. And `panel-method.ts:239` states that there is no viscosity anywhere in that function at
  all — inviscid potential flow is medium-independent by construction.
- **Embodied already carries gravity as a property of the scene.** `embodied_worker.py:99` holds
  `gravity: float` on the controller, applied at L114 in the acceleration term — and L223 builds it
  with `gravity=float(-self.model.opt.gravity[2])`. The controller reads gravity **from the model**.
  The substrate is already the authority; it is simply never varied.

So the medium is *mostly already a parameter* inside the force models. Where it is an assumption is
narrower and nameable:

1. **In the defaults and presets** — a seawater preset in ocean-lab, an ISA atmosphere in aero-lab.
2. **In one sibling module that hardcodes it.** `marine/services/power-budget.ts:32` defines a second
   `SEAWATER_DENSITY_KGM3 = 1025` and L70 multiplies by that constant directly. Inside one package,
   one module takes the medium as an argument and its sibling bakes it in — and the constant is
   defined twice, in `rotor-presets.ts` and again here.
3. **In the plant generators — both of them.**
   `embodied/src-routes/engine/physics/mjcf.ts:115` emits
   `<option timestep="…" gravity="0 0 -${G_MPS2}" integrator="implicitfast"/>` from a module constant
   `G_MPS2 = 9.81`, and emits **no `density` and no `viscosity` at all**. The drone flies in a vacuum
   at fixed Earth gravity, and nothing says so. `arm-mjcf.ts:135` writes `gravity="0 0 -9.81"` again,
   this time as a bare literal in `ARM_PREAMBLE` rather than through the constant. The arm is not a
   vehicle and is out of scope for D7's runs, but it is listed here because it is the same literal
   spreading to a second generator — evidence that the assumption accretes, which is the argument
   D9 turns on. Nothing in this ADR asks the arm to change.
4. **In the validity envelopes**, which are declared nowhere except aeropolar's Reynolds flag.

That is the honest cost picture, and it is much better than the ask implies. Interchangeable physics
here is a **contract-and-refusal** problem, not a solver-rewrite problem.

**The limit, stated up front so no slice is planned against it.** MuJoCo does contacts, gravity and
gusts. It does not do aerodynamics or hydrodynamics natively; lift, drag, harvest and thrust come from
each lab's own models, and that does not change. Interchangeability does **not** mean one solver
computes everything. It means the medium is a parameter instead of an assumption, and a model that
cannot honour a medium says so by name.

## Decision

### D1 — A vehicle is an owned record, and the design vector is the authored part

A vehicle is `(id, owner, kind, name, designVector, provenance, limits, createdAt, updatedAt)`.
Identity is the record. Geometry, performance tables, the parts model, the bill of materials, the
build sheet and every fabrication file are **derived** — computed from the design vector by a named
engine at a named version, cached against that pair, and never authored.

The rule that makes the operator's ask possible: **anything a person may type is a parameter, and
anything an engine computes is derived.** A derived figure that someone wants to override becomes a
parameter with an explicit override flag and shows as one; it never silently replaces a computed
number. Without that line there is no way to say what changing the wing stop angle invalidates, and
"change a parameter and the sea-state table recomputes" is exactly what does not work today.

The numeric path stays deterministic and model-free, as both labs already are. A concierge may draft a
design vector — `aero-lab` already does this — and nothing else.

### D2 — The stage is computed on read, never declared

Five stages, each defined by what the record can currently produce:

| Stage | True when |
|---|---|
| `concept` | a named design vector exists; nothing has been evaluated |
| `sized` | every performance figure the kind requires has been computed by the engine at the **current** vector |
| `parts-complete` | a parts model exists in which every part is printed (material, print notes, mass, a CAD program) or bought (mass, approximate price, a source line), and the mass/displacement budget closes against the sizing that used it |
| `fabricable` | every part has produced its declared fabrication output, each passed its own validator, and the build sheet is generated — all at the current vector |
| `built` | at least one measured quantity from a physical object has been recorded against its designed value |

Nobody sets a stage. It is a function of the record, recomputed every read, and a changed design
vector drops the vehicle back to the highest stage its current outputs support — the same
stale-output contract `scan-to-print` already enforces (changing measurements or settings retires the
report and the downloads; the server rechecks persisted state and refuses a stale request), applied
to a vehicle instead of a scan job. A stage a person can type is a label, and a label is what the
labs already fail to have usefully.

`built` is load-bearing precisely because neither existing vehicle can reach it. Nothing was wetted;
nothing was flown. Today the explorer would sit at `concept` and the Floater at `fabricable`, and the
distance between `fabricable` and `built` is the honest answer to "what stage is this at".

### D3 — It lives in the lab package that owns the kind, as owner-scoped rows

Not in core: a marine explorer is an application domain object, not swarm orchestration, and Rule 0c
settles that. Not in the artifact store: Send to… is an *exchange*, and `artifacts.provides` is a list
route over rows a package already owns (`scan-to-print` B4 is exactly this shape). An artifact has no
owner-editable parameter set and no stage, so a vehicle whose home was the artifact store would have
nowhere to keep the one thing a person authors.

So: package tables with owner RLS, following `embodied` (`001-embodied.sql`), `cad-studio`
(`001-cad-studio.sql`) and `scan-to-print` (`001-scan-to-print.sql`). `ocean-lab` and `aero-lab` each
gain their first migration. Both packages are `scope: person` work today and stay that way.

What is shared across labs is the **contract** — the column set, the meaning of each stage, the medium
shape in D7, the portable-object shape in D8, and the rule that derived values carry an engine
fingerprint — **not a runtime**. Each package implements it and a cross-package read-only test fails
when the shapes drift. That is deliberately the same posture as the open
[one-parts-model entry](../BACKLOG.md): shared rows travel as data, never as an imported runtime, and
the store's package-separation guard is not weakened to allow it. The constraint is not merely
stylistic here: aero-lab's environment is Python inside the package's own engine container, while
ocean-lab and embodied's design side are in-process TypeScript. Nothing can be imported across that
line even if the guard permitted it.

### D4 — A design study becomes live by being replayed from a seed, not by being imported

The explorer study is the record of one run of engines that now live in `ocean-lab`. Converting it:

- **Its inputs become a committed seed vector** in the package — envelope diameter, deployed span,
  tether length, float displacement, wing count and ranks, the mechanical stop angle, spindle
  diameter, the sea-state occurrence weights, the site parameter set. A fixture, versioned with the
  package, loadable as a starting vehicle.
- **Its numbers become derived** — the five-row sea-state table, the occurrence-weighted mean, km/day,
  km/year, the power budget and its margin, the mass/displacement check. Each recomputed from the
  vector on demand.
- **The document stays and is demoted to what it is:** a dated record of one run, linked from the
  seed. It is not regenerated and not edited to match a later engine. Instead a regression test
  asserts that the engine at today's version reproduces the study's published figures from the seed
  within a stated tolerance. When that goes red, someone decides whether the engine changed for a
  reason or broke — which is more than the document can do for itself today.
- **The generated design document** (the `design.md` route `embodied` already serves) is what a person
  reads for *their* vehicle. Two documents, two jobs, neither pretending to be the other.

**The honest-limits section survives as data on the record, not as prose in a file.** Each entry in
"What is not true" becomes a limit row on the kind and on the vehicle: an id, the sentence, and what
would retire it. For the explorer that is at least — no hardware of any kind; no site data is real;
drag is a correlation stack that should be read as 1.2–1.5× conservative; no structural analysis, and
a printed wing may not survive hinge loads at all; stop angles below ~15° are unmodelled while the
sweep keeps recommending them; the mesh validator does not check self-intersection, so a twisted loft
can pass every check and be unprintable; and two physics implementations exist with no parity test
between them. The generated document renders them, the surface shows the open count, and **a vehicle
cannot reach `built` while a limit marked blocking is open.** A kind that declares no limits is a
load-time refusal, not an empty list. A model that silently drops "what is not true" would be worse
than the document it replaced, so the limits are a required field rather than a courtesy.

### D5 — A lab owns a *kind*; nobody owns a *run*

The first draft of this ADR gave one owning lab per kind and justified it territorially. The
interchangeable-medium decision shows that conflated two different questions, so the conclusion
survives with a better reason and a narrower scope.

- **A kind is owned by the lab that owns its force models** — the lab that can answer "what does this
  machine do". That ownership does not move when the environment changes, because the explorer's
  wave-propulsion model lives where its physics lives regardless of which medium it is handed.
- **A run is `(vehicle, medium, plant)` and belongs to whoever asked for it.** Any lab may run any
  vehicle in any medium it can construct, subject to D7's refusals. The result is stored on the
  vehicle record with the medium id, the plant, and every engine fingerprint that answered. "The
  explorer in air" is therefore a recorded run on the explorer's record — not a second vehicle, and
  not a reason for a second lab to own it.
- **Amphibious stops being a governance question, which is the right outcome.** A machine is not
  amphibious because two labs claim it; it is amphibious because it has runs in two media that both
  returned meaningful results. That is a property of the record and it is computable. The earlier
  answer — one owner, a called sub-model, never a co-owner — still holds, because two records still
  means the mass budget can disagree with itself, which is the Floater's open problem inside a
  *single* set of files.

| Lab | Owns the kind | Never owns a kind |
|---|---|---|
| **Ocean Lab** | vehicles whose force models are water models — the 300 mm explorer, anything wave-driven or current-harvesting | — |
| **Aero Lab** | vehicles whose force models are air models — the Floater solar dynastat | — |
| **Embodied** | the recon drone and the Desk-6 arm, already there | — |
| **CAD Studio** | — | it is the kernel: a part program in, STEP / STL / drawing views out, and the transport D8 objects travel through |
| **Circuit Lab** | — | it owns the electrical block of a part |

Each lab declares its own kinds, the performance figures each requires, its limits, its fabrication
outputs, and — new in D7 — the media its force models are valid in.

### D6 — "Ready to fabricate" is a checkable state, and it is what a lab owes a builder

A lab that reports `fabricable` owes the person holding the printer:

1. **A parts model** — one row per real part. Printed: material, print notes, mass, and a CAD Studio
   program. Bought: mass, approximate price, and a source line. These bought rows are the same rows
   the open [one-parts-model entry](../BACKLOG.md) is about. This ADR does **not** create a fourth
   description of a servo: a vehicle's parts model declares those fields now so that adopting the
   shared rows later is a re-point, not a rewrite.
2. **A budget that closes** — printed plus bought plus the energy store summed, and the sizing
   recomputed *at* that mass (or that displacement, for a marine hull). `embodied`'s `buildDrone`
   already works this way. This is a gate, not a report, and the Floater is the argument: the ledger
   said one thing, real parts said 274 g more, and the consequence was a bigger hull and a bigger
   pack. A budget nobody has to satisfy is a budget that gets read past.
3. **Fabrication outputs per part, generated, each validated by the rule its kind has** — printed
   parts go through the real OCCT kernel to STEP and STL with closed / non-manifold / degenerate /
   Euler χ checks and the wall-thickness and overhang checks `scan-to-print` already computes; cut or
   sewn parts produce a flat pattern (DXF / SVG) with the unroll identity residual stated, which
   `aero-lab` already does for the hull gores; bought parts produce a BOM line with a source.
4. **A build sheet**, generated from the parts model and the print rules — not typed.
5. **A refusal to advance** when any of those is missing, failed, or stale against the current design
   vector. That is the whole definition: every declared output exists, is current, and passed its own
   validator.

Explicitly not owed and not implied: structural analysis, a manufacturing guarantee, or any
flightworthiness or seaworthiness claim. Both studies say no structural analysis was done, and
`scan-to-print` already states that a clean solver run is design evidence rather than a guarantee that
a part survives a load. **`fabricable` means the files are complete and self-consistent. It does not
mean safe to build and fly.** Any surface that renders the stage renders that sentence with it.

Generated versus hand-made today, stated plainly because the two sides are not symmetric: the
Floater's build package is engine output from a design vector, so the air side needs a record put
around a generator that already runs. The explorer's equivalents were produced by hand with scripts
and exist in no package, so the water side needs the generator written.

### D7 — Interchangeable physics: a medium is a named record, and a force model declares what it needs

**A medium is a first-class thing a person chooses**, not a property of the lab they happen to be in.
It carries, at minimum:

| Field | Why it is required |
|---|---|
| `id`, `label` | a run records which medium answered, the way it records which engine did |
| `gravityMps2` — a vector | a vector, not a scalar, so zero-g and a tilted test bench are expressible without a second concept |
| `densityKgM3` | the ρ every dynamic-pressure and buoyancy term already takes as an argument |
| `dynamicViscosityPaS` | dynamic, because that is what the atmosphere produces (`mu_Pas`); kinematic is `μ/ρ` and is derived, not stored twice |
| `speedOfSoundMs`, `temperatureK` | optional; present when the medium can answer, absent otherwise, never defaulted |
| `field(x, y, z, t)` | the medium's own motion — wind in air, wave and current in water — with its analytic gradient where the model has one. Aero Lab's `WindField.sample → WindSample` with a C1-continuous gradient is exactly this shape and is the seed |
| `freeSurface` — a plane, or none | the field the brief did not list and the one "the boat falls" versus "the boat floats" turns entirely on. A marine vehicle in a medium with no free surface is submerged or in free fall; that is a real distinction |
| `validity` bounds | the coordinate band the medium can answer over, **and a refusal outside it** |

**The refusal is promoted from a property of one module to a requirement of the contract.** The
atmosphere is valid over [−5000, 47000] m and raises rather than extrapolating, for the reason its own
source states. Every medium implementation owes that behaviour.

**Who owns the substrate.** `aerosim.env` is the right seed for the *shape* — an answer-machine keyed
on (x, y, z, t) returning fluid properties plus a field with its gradient, refusing outside its table.
It is the **wrong shape to adopt directly**, in three specific ways: it is air by name and by content
(the ISA table, a clear sky, Sutherland's gas viscosity law — seawater has none of those); it answers
on altitude with a geopotential conversion, where a water column is a depth axis with a different
pressure law and a free surface the atmosphere has no concept of; and it is Python in a package-owned
container while two of the three consumers are in-process TypeScript.

So: **the medium contract is a data shape, and each lab implements the media it can answer for.** Air
is `aerosim.env` behind the contract. Water is a new ocean-lab implementation — constant-density
seawater with a depth pressure law, a free surface, and the existing wave and current fields. Vacuum
is trivial: density zero, no field, no free surface — which is what the drone plant runs in today
without saying so. A medium a lab cannot answer for is **not silently substituted**.

**What a force model must ask for rather than assume.** Each model declares the medium properties it
requires, and gets exactly those. Two refusals, both by name:

- **`medium_property_unavailable: <property>`** — the model needs something this medium does not
  carry. Asking a wave-propulsion model for heave in a medium with no free surface is this refusal,
  and it must be this rather than a quiet zero: zero thrust and undefined thrust are different
  answers.
- **`model_not_valid_in_medium: <model>, <medium>`** — every property is present and the model still
  declines, because its **validity envelope** excludes this medium. This is the one that matters most
  and the one that does not exist today. An aircraft polar handed seawater would happily compute:
  ρ and μ are already arguments, and `½ρV²` does not care what ρ is. The numbers would be
  confidently wrong — the section data is a low-Reynolds **air** surrogate, cavitation is not in the
  model, and added mass is absent. **A model that silently returns air numbers in water is worse than
  a refusal**, so the envelope is declared by the model author, not inferred by the caller.

**And the existing guard cannot catch it — it would report `valid = True`.** The polar's only
self-check is Reynolds, over the band `RE_FLOOR = 30_000` to `RE_CEIL = 5.0e6`. Seawater's kinematic
viscosity (`1.05e-6` m²/s in ocean-lab's own constant) is roughly an order of magnitude below air's
at sea level, so the same speed and chord give a **higher** Reynolds number in water — moving the
point *away* from the floor the flag exists to enforce. Taking the Floater's own wing (0.52 m² over a
2.5 m span, cruising 4.00 m/s) as arithmetic rather than an engine run: roughly 5.6×10⁴ in air and
roughly 7.9×10⁵ in water, both comfortably inside the band. The point is certified valid, and a
NeuralFoil **air** surrogate answers it. A large or fast enough craft would overshoot `RE_CEIL` and
be caught, but only by accident — a Reynolds guard has no concept of which fluid produced the
Reynolds number. So `model_not_valid_in_medium` is necessary rather than tidy: it covers a failure
mode nothing here detects today.

The mechanism, though, is a generalisation rather than an invention: `aeropolar` already returns a
value **and a per-point `valid` flag**, and its selector only picks valid points. D7 extends that
shape from one axis to the medium as a whole.

**The acceptance case, by name: put the boat in air and it falls.** It is the cheapest possible proof
because the substrate is already there — `mjcf.ts:115` writes gravity into the scene from a module
constant, and `embodied_worker.py:223` reads the controller's gravity back out of the model. Give a
hull a mass and an inertia, put it in a medium whose density is air's and whose free surface is
absent, step the plant, and it falls at g. Put the same hull in the water medium and it must not —
and if the water medium cannot yet float it, it must **refuse by name** rather than produce a
plausible-looking float. That refusal is as much the proof as the fall is.

**Which combinations become meaningful, which are legal but useless, and which stay out of reach.**

*Meaningful — do these:*

- **Any rigid body in any medium, for gravity, mass and contact.** The boat falls; a drone in low
  gravity; a part dropped on a table. This is the plant's actual domain and it is real.
- **A rotor in either fluid.** Ocean Lab's BEMT already takes ρ and ν as arguments with seawater only
  a preset, so handing it air is a supported call today, not a rewrite. This is the single largest
  saving in the whole ADR.
- **A wing section's inviscid lift in either fluid**, because the panel method contains no viscosity
  and Cl is a function of shape and angle. That is a narrower and more defensible claim than "the wing
  engine works in water".
- **The same geometry and mass budget everywhere.** Displacement in water and mass in air are the same
  numbers read two ways.

*Legal but useless — refuse these by name rather than run them:*

- **An aircraft polar in water.** It computes and it is wrong: air section surrogate, no cavitation,
  no added mass.
- **A wave-propulsion model in air.** Its kinematic ceiling `U_max = w_heave / tan(β_stop)` is
  medium-independent, but the thrust term needs a heave the medium must supply, and air has no free
  surface to heave against.
- **Solar harvest underwater.** `aerosim.env.solar` is a clear-sky model with no attenuation through
  water; at depth it would return a sky.
- **Any fluid claim from the embodied plant as it stands**, because the MJCF generator emits no
  `density` and no `viscosity`. Whatever MuJoCo's own fluid model would do on this scene, **it was not
  run for this ADR** and the generator does not ask for it today.

*Out of reach — named so nobody plans against them:*

- **Free-surface hydrodynamics** — a hull genuinely floating, with waterplane stiffness, wave-making
  resistance and slamming. No engine here has a free surface.
- **Added mass and radiation damping**, which dominate a small submerged body's dynamics and are
  absent everywhere.
- **Cavitation**, absent from the panel method and from BEMT.
- **Aerodynamics inside the physics plant.** Contacts, gravity and gusts are its domain; lift and drag
  polars stay in each lab's own models.

### D8 — Interchangeable objects: what travels, and what stays private

A thing authored in one lab is usable in another when it carries five things and nothing else:

1. **Identity and provenance** — the authoring lab, the engine and version, and the design vector it
   came from, or an explicit statement that it has none (an imported mesh).
2. **Geometry** — a CAD Studio program where the object has one, a validated mesh where it does not.
   The program is the portable form and the mesh is the fallback, because a program can be re-derived
   and a mesh cannot.
3. **Mass properties** — mass, centre of mass, and the inertia tensor about it, in the object's own
   frame, each with its provenance. `embodied` already estimates inertia from where parts sit; that
   estimate travels **as an estimate** rather than being silently re-derived by the receiver.
4. **An attachment frame** — a named origin and axes plus zero or more named attachment points, in the
   frame convention CAD Studio already fixes (millimetres, Z up, footprint centred, Z from 0).
   Without named points, "attach the wing to the explorer" has no defined meaning.
5. **Its force model, if it has one, with the medium properties that model requires and the media it
   is valid in** (D7). A wing carries its polar and says it needs ρ and μ; a bracket carries nothing.

**What a lab must accept:** those five, and it must not require anything more in order to place, weigh
or collide the object. **What stays private:** the authoring lab's solver internals, its surface state,
its parameter sweeps and its caches. A receiving lab may **read** a foreign force model's declared
requirements and refuse the object when its medium cannot satisfy them; it may not re-implement or
reinterpret that model.

**The transport already exists and this adds no new one.** Objects travel as data through CAD Studio's
model POST — which `scan-to-print` (contours) and `embodied` (printed parts) both already use — and
through the Send to… registry for the file-shaped hand-off. Never as an imported runtime across
packages; D3's constraint applies unchanged.

This sits deliberately one level above the open shared-parts entry: **a part is a row; an object is a
placeable body with a frame, mass properties and possibly a force model.** The evidence that the
disease is real at this level too is in one package: `SEAWATER_DENSITY_KGM3 = 1025` is defined twice
inside ocean-lab, in `rotor-presets.ts` and again in `marine/services/power-budget.ts`, and the second
is consumed as a constant rather than a parameter.

### D9 — Ship the operator's own acceptance case first

The first draft made the first slice an Explorer tile. The medium decision changes that, and the
reason is cost rather than taste.

- **The falling boat is now cheaper than it looks and the tile is dearer than it looked.** The
  substrate exists (gravity already reaches the controller from the scene), so the change is a medium
  record plus the generator's `<option>` line — not a solver. Meanwhile an Explorer tile that shows
  *runs* wants runs to exist.
- **The falling boat teaches the thing that gets more expensive with time.** Medium-as-assumption
  accretes: `power-budget.ts:70` is already one instance, and every module written before the contract
  is another to unbake later. The record-and-stage work is additive and does not get harder.
- **It is his own case**, so he will know within seconds whether it is real.

**Recommendation: the falling boat first, with the explorer hull as a single solid** built from the
published envelope and all-up mass rather than from the 11-part parts model — which does not exist yet
and is the largest slice in this plan. The Explorer tile moves to second and gains something it could
not have had first: a run table with runs in it.

**The risk this reordering carries, stated rather than discovered later:** a single-solid hull with a
mass and no displacement geometry falls correctly and will **not** float correctly, because nothing
here models a free surface. The slice must show the fall *and* refuse the float by name. A slice that
produced a plausible float would have disproved its own contract.

## Implementation

Nothing below is built. Store-repo work in `ocean-lab`, `aero-lab` and `embodied`; no core code.

| Slice | What lands | What the operator opens, and does | Cost |
|---|---|---|---|
| **S1 — the boat falls** | The medium record (D7) with three implementations — vacuum, air behind `aerosim.env`, seawater; the MJCF `<option>` fed from the chosen medium instead of `G_MPS2`; the explorer hull as one solid from its published envelope and mass; the two named refusals. **The property values travel as data, not as a fourth copy** — see the note below the table | `/cockpit/?app=embodied`: choose a medium, drop the hull. In **air** it falls at g. In **seawater** it refuses by name rather than pretending to float | **Small.** One record, one generator change, one body. No solver is written |
| **S2 — the Explorer record** | The vehicle record and computed stage in `ocean-lab` (its first migration, owner RLS), the explorer seed vector as a committed fixture, the limit rows, an **Explorer** tile, and the run table S1 fills | `/cockpit/?app=ocean-lab` → **Explorer**. Change the wing stop angle or tether length, evaluate, and watch the five-row sea-state table, the occurrence-weighted mean, km/day and km/year move; the stage badge drops to `sized`; the open limits and the recorded runs list underneath | Small–medium. One migration, one surface, the evaluate path wired to engines that already exist |
| **S3 — the explorer's parts and geometry** | The parts model and each watertight part as a CAD Studio program, with **Open in CAD Studio** each — the B16 pattern, second machine, different lab — plus the portable-object shape (D8) on what it emits | The same tile: a parts table with masses and prices, a displacement budget that closes or refuses, **Open in CAD Studio** per part, a generated design document. Stage reaches `parts-complete`, then `fabricable` when every part exports clean | **Largest slice.** Eleven part programs written against the kernel's feature contract and validated |
| **S4 — the Floater record** | The Floater as a record in `aero-lab`: its first migration, the existing `export_build_files.py` run stored as the first evaluation, `BOM_v2`'s mass delta as a budget check that must close, its force models' validity envelopes declared | `/cockpit/?app=aero-lab`: the Floater as a saved vehicle with a stage, its reference-design folder linked as the dated artifact of one run rather than mistaken for the design | Medium, mostly bookkeeping over a generator that already runs. The budget check is expected **red on first run** — that is the 274 g, and it is the point |
| **S5 — the guards** | Cross-package read-only drift tests over the record shape, the stage function, the medium shape **and the medium property values**, and the portable-object shape; the study-reproduction regression against the seed; a case per named refusal in D7 | Nothing to open — this is what stops three labs describing a vehicle, a medium or a part three ways | Small |

**A note S1 cannot skip.** D3 forbids a cross-package runtime import, so S1's air and seawater media
are implemented inside `embodied` — a third TypeScript location, distinct from aero-lab's Python
`aerosim.env` and ocean-lab's rotor and marine code. Written naively that adds a third and a fourth
independent answer to "what is seawater", which is precisely the defect this ADR names when it points
at `SEAWATER_DENSITY_KGM3` being defined twice inside one package. The existing machinery is the
answer and S1 must use it: **the medium's property values are one committed data row per medium,
shared across packages as data exactly as D3 requires, with the S5 drift test failing when a lab's
copy disagrees.** An implementation is allowed to differ in what it can *answer* — aero-lab resolves
density by altitude and ocean-lab by depth — but not in what seawater's density *is*.

Not in scope of any slice: hardware, a tank test, a wind tunnel, a structural solver, free-surface
hydrodynamics, added mass, cavitation, aerodynamics inside the physics plant, the arm's own generator,
the shared parts-model rows themselves (their own backlog entry), and any claim that a `fabricable`
vehicle is safe.

## Reconstruction accuracy should be measured against public scan datasets

Raised in the same conversation, and it is a separate decision about `scan-to-print` that this ADR
records rather than designs.

The operator is right about the reason. A photograph from a phone gives no error metric to regress
against — there is no reference surface, so a scan can only be checked against itself. The package's
whole test corpus today is self-consistency and fixture recovery: a synthetic cup carved to within
5 % of π·14²·45 mm³, a lattice box filling to exactly 72 000 mm³, meshes proven closed and manifold,
and joint-registration residuals reported per view. Those prove the code does what it says. None of
them says how wrong a scan of a real object is, and none of the seventeen open backlog items asks.

It matters more here than it would elsewhere because the package's headline limit is **systematic,
not noise**: the photo lane produces the visual hull, so cavities, undercuts and holes not aligned
with a view are filled solid, and the depth and LiDAR lanes are what recover them. A one-sided error
of unknown size is exactly the thing a reference solid sizes and a self-consistency test cannot.

What that means concretely:

- **Dataset class:** object-scale multi-view reconstruction benchmarks distributed *with* a
  metrology-grade reference mesh. A candidate qualifies if it gives a reference surface in real
  units, capture coverage sufficient to fill the six canonical views, and a licence permitting the
  derived numbers to be published. Room-scale SLAM sets and 6-DoF pose-estimation sets do not
  qualify — a pose is not a surface, and measuring against one measures nothing about the hull.
- **Metric: two numbers, because the error is one-sided.** (1) **Signed** surface deviation against
  the reference, reported as a distribution — median, 95th percentile, maximum — with the sign kept,
  so hull over-fill reads positive and is not cancelled by under-fill elsewhere. (2) **Volume ratio**
  reconstructed over reference. A single symmetric Chamfer distance would average away precisely the
  failure the package already documents.
- **What counts as a pass:** a published figure per lane plus a regression bound — not an invented
  tolerance. The first run establishes the number, it goes into the report the package already
  generates, and the gate is that a later change may not worsen it by more than a stated margin.
  Fixing an absolute tolerance before the first measurement would be inventing a number, which is the
  discipline both design studies kept (the explorer study deleted a fabricated BOM rather than
  publish it).
- **What this is not:** it does not validate the depth or LiDAR lanes against a real sensor — that is
  the package's own open real-device item — and a passing figure does not become a manufacturing
  accuracy claim. The package's measurement-reconciliation note already says a ruler entry is not an
  exact axis resize, and that stays true.

**Not resolved here, deliberately:** which dataset; whether any candidate's capture geometry can fill
the six canonical views without the perspective-to-orthographic reprojection that exists in the
engine but has no route; and where reference meshes live on the box, since a benchmark set is far too
large to vendor into a store package. Those are the three questions the work starts with, and none of
them has an answer yet.

## Consequences

**Easier.** A machine has one home and one truth. A changed parameter invalidates exactly what it
invalidates, and says so. A person can see what stage a vehicle is at without reading a 200-line
document and inferring it. The medium becomes something chosen rather than implied, so "run it
somewhere else" stops being a rewrite. An object authored in one lab can be placed, weighed and
collided in another without that lab knowing how it was made. The two finished studies stop being
unreachable.

**Harder.** Two labs that own no tables now own tables, with a migration and owner RLS each. Every
derived number needs an engine fingerprint, and now a medium id too. Every force model author has to
declare a validity envelope, which is real work and is the part most likely to be skipped — an
undeclared envelope must therefore fail closed, refusing every medium but the model's default, rather
than defaulting to permissive. The stage function is a new thing to get wrong, and getting it wrong
optimistically — reporting `fabricable` while an output is stale — is worse than having no stage at
all, which is why the recompute-on-read rule is not negotiable.

**Named risks.**

- The explorer's geometry does not exist anywhere, and its own limits say the mesh validator does not
  check self-intersection and that no structural analysis was ever done. S3 can therefore produce
  eleven parts that pass every check the lab has and that a structural check would reject. The stage
  must never be read as buildability, and D6's closing sentence is there for that reason.
- **Interchangeability invites a claim it does not support.** The moment a vehicle can be run in any
  medium, a surface that shows a number without showing which medium and which engine produced it is
  a fabrication. Every run result carries its medium id and every engine fingerprint, or it is not
  displayed.

**Cost.** Store-repo work across three packages plus this document. No core code, no new service, no
new container. The medium half is cheaper than the ask implies, because the force models already take
ρ and μ as arguments; what is missing is the record, the refusals and the envelopes. If the shared
parts-model entry lands first, S3 gets cheaper; if it lands after, S3's bought rows are re-pointed.

## What this does not decide

- The shared parts-model row shape itself — that is its own backlog entry, and this ADR consumes it
  rather than pre-empting it.
- Whether a vehicle record, a medium or an object is ever shared beyond its owner, or reachable
  through Send to…. Both packages are per-person today and S1–S5 keep them that way.
- Whether the physics plant's own fluid options are ever enabled. The MJCF generator emits none today,
  nothing here was run to find out what they would do on this scene, and D7's refusals hold either
  way.
- Any hardware decision. Nothing here authorises buying, building, wetting or flying anything.
