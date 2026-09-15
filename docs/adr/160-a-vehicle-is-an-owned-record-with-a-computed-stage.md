# ADR-160: A vehicle is a record the lab owns, and its development stage is computed from what it can produce

Date: 2026-09-15
Status: **Proposed — nothing here is built.** No code exists for any decision below. The slices are
listed in "Implementation" and tracked in [BACKLOG](../BACKLOG.md).

Related: [ADR-085](085-remote-app-packages-and-registries.md) (store packages own their domain),
[ADR-036](036-bot-owned-application-architecture.md) (the owner of a domain owns its state),
[ADR-097](097-app-suites-primary-categorization.md) (`ai-engineering` shelf),
[ADR-150](150-deterministic-object-reconstruction-scan-to-print.md) (the stale-output contract this
borrows), [ADR-151](151-eyes-and-hands-embodied-swarm.md) and
[ADR-152](152-embodied-physics-and-training-lab.md) (the `embodied` designer this generalises),
[ADR-153](153-iterative-cad-kernel-cad-studio.md) (CAD Studio, the kernel that makes a part real),
[ADR-154](154-local-electromechanical-lab-circuit-lab.md) (Circuit Lab),
[ADR-139](139-artifact-exchange-send-to-registry.md) (Send to…, which is an exchange and not a home).
User-facing companion: [the maker labs guide](../guides/maker-labs.md).

## Context

Operator, 2026-09-15:

> "with blade studio we had an amphibious vehicle fully specced out and an air vehicle fully specced
> out … based on those specs i want to see the tools we created represent their development stage and
> have a way to actually develop them … we should have a water lab and an aero lab … there were waves
> and energy and fabrication … i see nothing but some boxes and lines."

Both vehicles exist. Neither is reachable from a surface, and neither can be changed.

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
and the deltas between them; a build sheet; a design snapshot; and five validator outputs. **These are generated, not hand-drafted**
— `engine/export_build_files.py` writes the whole set from a design vector, and its own README says
so. That correction matters: the air side already has the generator this ADR is about. What it does
not have is a *record*. The folder is one run, committed, and it is already out of step with its own
package: the README states the numbers stand on the ideal propulsion chain, that the real-chain
promotion gate is red, and that real sourced parts came in **274 g heavier** than the certified
ledger, which is why the as-built craft needs a 98.0 Wh pack instead of the 79.6 Wh the catalogue
design assumed. A snapshot cannot tell you it has gone stale. A record can.

**What the labs are today.** `ocean-lab` exposes exactly two surfaces — Harvest Console and Blade
Studio — and neither knows a vehicle exists; Blade Studio is component-level (NACA sections,
panel-method polars, Cp sweeps, blade export). `aero-lab` exposes one. Both own **no tables at all**:
neither package has a `migrations/` directory, nothing is stored, and every result is computed from
what was posted and then discarded. That is the whole diagnosis. The labs are analysis surfaces over
anonymous parameter vectors. There is no object to have a stage, so of course nothing represents one,
and "boxes and lines" is the honest visual consequence of a lab that cannot name the machine it is
drawing.

**The pattern already exists, shipped, in another package.** `embodied` B16 (DONE 0.6.0) is
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
develop. Everything below is the missing half.

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

What is shared across labs is the **contract** — the column set, the meaning of each stage, and the
rule that derived values carry an engine fingerprint — **not a runtime**. Each package implements it
and a cross-package read-only test fails when the shapes drift. That is deliberately the same posture
as the open [one-parts-model entry](../BACKLOG.md): shared rows travel as data, never as an imported
runtime, and the store's package-separation guard is not weakened to allow it.

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

### D5 — Which lab owns what, and what happens to an amphibious machine

A kind belongs to the lab that owns the physics bounding its performance.

| Lab | Owns | Does not own |
|---|---|---|
| **Ocean Lab** | vehicles propelled or powered by water — the 300 mm explorer, anything wave-driven or current-harvesting | air vehicles |
| **Aero Lab** | vehicles whose lift and power come from air — the Floater solar dynastat | water vehicles |
| **Embodied** | the recon drone and the Desk-6 arm, already there | — |
| **CAD Studio** | no vehicle. It is the kernel: a part program in, STEP / STL / drawing views out | anything with a design vector |
| **Circuit Lab** | no vehicle. It owns the electrical block of a part | anything with a hull |

**An amphibious vehicle has one owning lab and no co-owner.** Two owners means two records, and two
records means the mass budget can disagree with itself — which is not hypothetical, since the
Floater's whole open problem is a 274 g ledger disagreement inside a *single* set of files. The other
lab is entered as a sub-model the owner calls: an explicit cross-lab evaluation, requested by the
owning record, whose result is stored with the answering engine's fingerprint. The explorer is
already the test case — a surface float plus a submerged sub, with a current spindle feeding
electronics — and it is decided by water; its power block does not make it an aircraft. If a genuinely
two-regime machine ever makes that unworkable, the answer is a new kind in one lab, not a shared
record.

The record contract is shared; the kinds are not. Each lab declares its own kinds, the performance
figures each requires, its limits and its fabrication outputs — which is what keeps a water vehicle
from having to pretend it has a wing polar.

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
and exist in no package, so the water side needs the generator written. That asymmetry is why the
slices are ordered the way they are below.

### D7 — Ship the smallest thing that answers "boxes and lines" first

S1 is a third Ocean Lab tile called **Explorer** that does one thing: the named machine, its numbers,
and its stage. No geometry, no parts, no CAD. If changing one slider does not visibly move the
sea-state table, nothing later is worth building.

## Implementation

Nothing below is built. Store-repo work in `ocean-lab` and `aero-lab`; no core code.

| Slice | What lands | What the operator opens, and does | Cost |
|---|---|---|---|
| **S1** | The vehicle record and the computed stage in `ocean-lab` (its first migration, owner RLS), the explorer seed vector as a committed fixture, the limits rows, and an **Explorer** tile | `/cockpit/?app=ocean-lab` → **Explorer**. Change the wing stop angle or the tether length, press evaluate, and watch the five-row sea-state table, the occurrence-weighted mean, km/day and km/year move — the stage badge dropping to `sized` and the open limits listed underneath | Small–medium. One migration, one surface, the evaluate path wired to engines that already exist |
| **S2** | The explorer's parts model and its geometry as CAD Studio programs, one per watertight part, with **Open in CAD Studio** each — the B16 pattern, second machine, different lab | The same tile: a parts table with masses and prices, a displacement budget that closes or refuses, **Open in CAD Studio** per part, and a generated design document. Stage reaches `parts-complete`, then `fabricable` when every part exports clean | **Largest slice.** Eleven part programs written against the kernel's feature contract and validated |
| **S3** | The Floater becomes a record in `aero-lab`: its first migration, the existing `export_build_files.py` run stored as the first evaluation, `BOM_v2`'s mass delta as a budget check that must close | `/cockpit/?app=aero-lab`: the Floater as a saved vehicle with a stage, its reference-design folder linked as the dated artifact of one run rather than mistaken for the design | Medium, mostly bookkeeping over a generator that already runs. The budget check is expected to go **red on first run** — that is the 274 g, and it is the point |
| **S4** | The cross-package read-only drift test over the record shape and the stage function, plus the study-reproduction regression against the seed | Nothing to open — this is the guard that stops three labs describing a vehicle three ways | Small |

Not in scope of any slice: hardware, a tank test, a wind tunnel, a structural solver, the shared
parts-model rows themselves (their own backlog entry), and any claim that a `fabricable` vehicle is
safe to build and operate.

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
document and inferring it. The two finished studies stop being unreachable — one becomes a seed, the
other becomes a record around a generator that already works. The distance between "the files are
complete" and "we built one" becomes visible instead of rhetorical.

**Harder.** Two labs that own no tables now own tables, with a migration and owner RLS each, and both
acquire a persistence surface they have never had. Every derived number needs an engine fingerprint,
so the evaluate paths gain a version they have to maintain honestly. The stage function is a new
thing to get wrong, and getting it wrong optimistically — reporting `fabricable` while an output is
stale — is worse than having no stage at all, which is why the recompute-on-read rule is not
negotiable.

**Named risk.** The explorer's geometry does not exist anywhere, and its own limits say the mesh
validator does not check self-intersection and that no structural analysis was ever done. S2 can
therefore produce eleven parts that pass every check the lab has and that a structural check would
reject. The stage must never be read as buildability, and D6's closing sentence is there for that
reason.

**Cost.** Store-repo work across two packages plus this document. No core code, no new service, no
new container. If the shared parts-model entry lands first, S2 gets cheaper; if it lands after, S2's
bought rows are re-pointed at it.

## What this does not decide

- The shared parts-model row shape itself — that is its own backlog entry, and this ADR consumes it
  rather than pre-empting it.
- Whether a vehicle record is ever shared beyond its owner, or reachable through Send to…. Both
  packages are per-person today and S1–S4 keep them that way.
- Any hardware decision. Nothing here authorises buying, building, wetting or flying anything.
