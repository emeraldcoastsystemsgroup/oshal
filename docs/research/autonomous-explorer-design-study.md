# Autonomous explorer — design study

**Status:** Research study. Simulation only. Nothing has been built, wetted, or tested.
**Date:** 2026-08-02
**Code:** the engines are not in this repo. They live in the `ocean-lab` package in the public
app store: [energy/](https://github.com/emeraldcoastsystemsgroup/oshal-apps/tree/main/ocean-lab/src-routes/engine/energy), [geometry/](https://github.com/emeraldcoastsystemsgroup/oshal-apps/tree/main/ocean-lab/src-routes/engine/geometry), [marine/](https://github.com/emeraldcoastsystemsgroup/oshal-apps/tree/main/ocean-lab/src-routes/engine/marine),
[ground/](https://github.com/emeraldcoastsystemsgroup/oshal-apps/tree/main/ocean-lab/src-routes/engine/ground), [rotor-design/](https://github.com/emeraldcoastsystemsgroup/oshal-apps/tree/main/ocean-lab/src-routes/engine/rotor-design). This study was written while they
still sat under `src/shared/` and `src/features/`; they were carved out of the kernel under Rule 0c
(core PR #137, store PR #54) because a tidal-site model serves a user doing a job — it is not
swarm orchestration.
**Report:** [ambient-energy-vessel-report.pdf](ambient-energy-vessel-report.pdf) — drawings, the
governing math, a 432-design sweep, and a bill of materials.
**Decision record:** none. No ADR was written, and none of this was decided through one.

## What this is

A study of machines that move using ambient energy and no fuel: tidal and wave flow, and
subterranean thermal gradient. It produced working physics models, a parametric geometry and CAD
export layer, and a fully modelled 300 mm ocean explorer.

It did **not** produce hardware, a swarm application, or anything a user can open in the running
stack. Read the "What is not true" section before quoting any of it.

## The question

Can a machine collect ambient energy and move indefinitely, and can we evaluate that claim with
numbers rather than intuition?

Answer: yes for the energy, no for "indefinitely". Endurance is bounded by fouling and mechanical
wear, not by the energy budget. That finding is the study's main result and it recurs in every
domain examined.

## What was modelled

### Marine — tidal and current harvest

Tidal current as a sum of astronomical harmonic constituents (M2, S2, N2, K1 …). Constituent
periods are fixed by orbital mechanics, which is why a tidal site's worst case is *calculable*
decades ahead rather than forecast. The spring/neap beat is not a parameter — it emerges from M2
and S2 drifting in and out of phase at 14.77 days.

Two results worth keeping:

- **Mean harvested power is 4/(3π) ≈ 42.4% of peak-speed power**, not the power at mean speed.
  Because harvest goes as v³ and flow is sinusoidal, sizing off mean speed *understates* real
  harvest by exactly 6/π² — flow variability helps you. Jensen's inequality, and it is worth about
  a 65% correction.
- **Average power is not a schedule.** A design can harvest 1.96× the energy it spends across a
  year and still be dead for 600 hours of it, because the surplus arrives in the wrong season and
  the store cannot bridge. Any verdict based on a margin ratio alone is wrong.

### Ground — soil thermal gradient

Not the geothermal gradient — at 25 K/km a 3 m probe sees 0.075 K, which is nothing. The usable
gradient is the **thermal wave lag**: surface temperature swings, soil damps and delays it with
depth, and the difference between two depths is harvestable through a thermoelectric couple.

```
T(z,t) = T_mean + A·e^(−z/d)·cos(ωt − z/d),   d = √(2α/ω)
```

At α = 0.5×10⁻⁶ m²/s the damping depths are **2.241 m annual** and **0.117 m diurnal** — verified
numerically, and the signature that the model is the real harmonic solution.

Two results:

- **Shallow beats deep, by 3.5×.** A 0→0.3 m junction pair harvests 17.9 mW against 5.1 mW for a
  0→2.5 m pair. Thermal resistance scales with separation (`R = L/kA`) and **heat flow is what
  converts, not ΔT**. The deep probe sees a larger temperature difference and chokes on its own
  path length. This inverts the intuitive answer.
- **The equinox null is the design driver.** An annual-only pair produces nothing for weeks twice a
  year. A dual pair — shallow diurnal plus deep annual — has non-coincident nulls and a worst-case
  gap measured in hours instead. That is the whole architecture.

### Rotor — blade geometry to power coefficient

NACA 4-digit sections, a Hess-Smith vortex panel method for inviscid C_L, Viterna post-stall
extension, and blade-element momentum theory with Prandtl tip *and* hub loss and the Glauert
high-induction correction.

- **Betz holds.** An ideal rotor (60 blades, zero drag) peaks at **Cp = 0.5776** against the
  16/27 = 0.5926 limit — 97.5%, approached from below, never crossed across 24 tip-speed ratios.
  A BEMT that breaks Betz is wrong; this one does not.
- **Small rotors cannot reach utility Cp.** The same geometry gives **Cp 0.319 at 150 mm** tip
  radius and **0.422 at 10 m**. A 24.5% relative loss, entirely Reynolds. C_L is identical at both
  scales (0.685 — same inflow triangle) but C_D is 0.0372 against 0.0113, so L/D falls from 60.5
  to 18.4. Section Reynolds at 75% span: 74,436 versus 4,976,191.
- **Cp versus scale is not monotone.** 0.319 → 0.426 → 0.417 → 0.422 → 0.429 across R = 0.15 to
  50 m. The dip between 0.6 and 2 m is the laminar-to-turbulent transition, where turbulent skin
  friction genuinely exceeds laminar at the same Reynolds. Real airfoil data shows the same
  feature. It was left in rather than smoothed away.

### Wave propulsion

A wing that moves forward at U while heaving at w sees flow inclined at θ = atan(w/U). Lift acts
perpendicular to that inclined flow, so it tilts forward and its forward component is thrust:

```
T = ½ρV²S · [ C_L·sinθ − C_D·cosθ ]
```

Thrust is positive only when tanθ > C_D/C_L. Both halves of the wave cycle push, because the wing
flips to its opposite stop and θ reverses with it.

**The kinematic ceiling** is the governing result:

```
U_max = w_heave / tan(β_stop)
```

Once forward speed rises enough that θ drops below the wing's mechanical stop, the wing
weathervanes flat, angle of attack goes to zero, and thrust goes to exactly zero — while profile
drag remains. Every computed equilibrium sits just under this ceiling. **Wing area is nearly
irrelevant**: going from 2 wings to 20 moves speed from 1.94 to 2.34 knots.

Consequence: **wave steepness governs, not wave height.** The same 1 m wave gives 2.23 knots at a
6 s period and 1.06 knots at 12 s. Site selection follows period.

## The explorer

A 300 mm envelope vehicle, modelled completely.

| | |
|---|---|
| Body diameter | 280 mm |
| Wing span deployed | 296 mm |
| Tether | 2.0 m |
| Float displacement | 24.1 L → 24.7 kg buoyancy |
| Parts | 11, all independently watertight |
| Assembly | 11,976 triangles |

Spar float at the surface, 2 m tether, 110 mm sub carrying four propulsion wings on two ranks, one
rudder — the only actuated surface on the vehicle — and a 190 mm three-blade current spindle
supplying the electronics.

### Performance

| Sea state | Speed | Knots | km/day |
|---|---|---|---|
| Flat (H 0.10 m) | 0.000 | 0.00 | 0.0 |
| Calm (H 0.25 m) | 0.033 | 0.06 | 2.8 |
| Light swell (H 0.50 m) | 0.103 | 0.20 | 8.9 |
| Moderate (H 1.0 m) | 0.396 | 0.77 | 34.2 |
| Rough (H 2.0 m) | 1.310 | 2.55 | 113.2 |

Occurrence-weighted over a temperate coastal year: **0.46 knots mean, under way 65% of the time,
20.4 km/day, 7,444 km/year.** Below roughly 0.5 m of wave height it does not move at all — it
drifts and waits.

**The scale cost:** the same concept at full Wave-Glider size does 2.23 knots in a moderate sea.
At 300 mm it does 0.77. Fifteen times less wing area and a much harsher Reynolds regime.

### Endurance

Propulsion consumes nothing, so duration is not an energy question.

- Electronics draw ~30 mW; the spindle averages 548 mW — 18× margin.
- That harvest is **bursty**: 93% arrives during the 8% of the year that is rough. The battery
  exists to carry 30 mW across calm stretches, not to extend range. 100 Wh covers 139 days with
  the spindle never turning.
- **Biofouling ends the mission.** 30–90 days uncoated before thrust degrades materially — roughly
  1,800 km at this speed. Coated with a wiper, 6–12 months.
- **Hinge wear is second.** 5.3 million cycles per year at a 6 s period sets overhaul interval.

## What is not true

Read this before citing anything above.

- **Nothing was built.** No hardware exists. No tank test, no sea trial, no physical validation of
  any kind.
- **No site data is real.** Every tidal constituent set and soil profile is an illustrative
  parameter set, labelled as such in the code. No verdict here is site-specific.
- **Drag is a correlation stack, not a solved boundary layer.** Section C_D should be read as
  roughly 1.2–1.5× conservative.
- **No structural analysis.** Nobody has checked whether a printed wing survives hinge loads at
  2 knots in a 2 m sea. That may push the part out of print entirely.
- **Wave-glider stop angles below ~15° are unmodelled.** The sweep says shallower is faster all the
  way down to 5°; real vehicles use 20–25°. Hinge loads, control authority and tether snatch are
  absent from the model.
- **The mesh validator does not check self-intersection.** Topology is verified closed and
  manifold. A sufficiently twisted loft could pass every check and still be unprintable.
- **Two physics implementations exist with no parity test.** The browser consoles mirror the server
  models; nothing asserts they agree on a single number.
- **This never ran in the swarm.** No ticket, no bot-node, no manifest, no persona. It was built
  by hand with scripts. That is a process failure, not a modelling one.

## What is hard-checked

- 378 unit assertions across nine spec files; typecheck clean on both project configs.
- Thirteen defects found by adversarial review and fixed, two of which certified seasonally dead
  designs as perpetual.
- The panel method reproduces thin-airfoil theory: C_L(0) = 5.7×10⁻¹⁵ on a symmetric section,
  lift slope → 2π per radian, NACA 4412 zero-lift angle −4.27° against a published ≈ −4.1°.
- Geometry and export survived 17 of 17 deliberate mutations.
- Every explorer part: 0 open edges, 0 non-manifold, 0 degenerate facets, Euler χ = 2. Assembly
  STL byte length exactly 84 + 50 × 11,976 — arithmetic the writer cannot fudge.

## Cost

Deliberately not estimated. Any figure here would be invented — no sourcing, no quotes, no vendor
contact. An earlier draft carried a bill of materials with per-line costs; it was removed because
the numbers were fabricated and reading them as a budget would be a mistake.
