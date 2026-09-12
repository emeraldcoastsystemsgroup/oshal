# ADR-150: Deterministic object reconstruction — one occupancy grid for silhouettes, depth and LiDAR (the Scan to Print package)

**Status:** Accepted — **BUILT** 2026-09-12 as the store package `scan-to-print` 0.1.0
(`emeraldcoastsystemsgroup/oshal-applications`, `scan-to-print/`). Nothing in core changed; this
ADR records the decision because the occupancy-grid contract is a platform building block that
later sensor work (ADR-111's LiDAR imports, ADR-140's device hands) will build on.
**Related:** [ADR-111](111-spatial-mapping-3d-reconstruction.md) (room-scale video→3DGS; the
`.ply` import lane it added is the same file this package's point-cloud lane reads),
[ADR-140](140-local-device-access.md) (the swarm's hands — its "Swarm → 3D printer: does not
exist" row is now answered by this package's network printer adapters),
[ADR-036](036-bot-owned-application-architecture.md) (bot owns the domain; here the domain is
arithmetic and the bot only briefs), [ADR-085](085-remote-app-packages-and-registries.md)
(store package posture), [ADR-097](097-app-suites-primary-categorization.md) (suite
`ai-engineering`).

## Context

Operator ask (2026-09-12): *"a 3d printing ai app but with a high degree of deterministic
abilities … take a video or several pictures of an object and create an engineering drawing …
top right bottom left front back … then generate the 3d rendering … and be able to submit that
to a 3d printer … it's important that this technology is clearly documented as it is a building
block for lidar."*

Three things in that sentence constrain the design:

1. **Deterministic.** The geometry path may not contain a model, a seed, or an iteration to a
   tolerance. Same photos, same ruler number, same bytes. This rules out learned single-image
   depth, NeRF/3DGS training (ADR-111's engine, which is right for rooms and wrong here), and
   any "AI guesses the back" step.
2. **The six views are the interface.** The person names which face each photo shows. That is
   both the drawing convention (third-angle, ASME Y14.3) and the registration key — the pipeline
   does not have to discover camera poses.
3. **A building block for LiDAR.** Whatever represents the solid must accept a range sensor's
   information without a redesign. A silhouette says "nothing along this ray"; a LiDAR return
   says "nothing along this ray *until this range*"; a point cloud says "the surface is here".
   The representation has to take all three.

What already existed: ocean-lab's geometry slice (STL/OBJ writers, the index-identity mesh
validator) in the store; ADR-111's `.ply` import lane in core; ffmpeg and sharp in the api
image; the personal-data vault for owner-key field encryption; the explicit-write-confirmation
helper. Nothing for object-scale reconstruction, drawings, or printer submission.

## Decision

**D1 — The solid is a binary occupancy grid, and every lane writes into it.** Voxels are 1 or
0, never a probability, so carves compose in any order. The grid always carries an empty outer
shell; that shell is the meshing precondition, not a convenience. Ceiling 200³.

**D2 — One fixed world frame and six fixed camera frames.** Right-handed, Z up, millimetres,
object resting on Z = 0 with its footprint centred, front facing −Y. Each canonical view is a
signed-axis triple (image right, image down, look) proven right-handed by a spec. Every sensor
projects into this frame; no other module defines an axis.

**D3 — The photo lane is the visual hull, registered by bounding box against one ruler
measurement.** Silhouette = Otsu on colour distance from a border-estimated background, open/
close, largest component, holes filled. Extents propagate from the known dimension through the
views' pixel ratios; an extent no view shows is *assumed and flagged* (report, drawing, UI).
Limitation stated everywhere it matters: cavities, undercuts and unaligned holes are filled.

**D4 — The depth lane ships now, exercised by a simulated sensor.** `carveDepth` removes only
free space in front of a measured surface; a no-return pixel removes nothing (silence is not
emptiness). `renderDepth` ray-marches a grid into the same struct, so the lane is proven end to
end (a hollowed cylinder's cavity recovered to the voxel) with no hardware and no claim of
hardware. A real device integration is "produce this struct".

**D5 — The point-cloud lane reads `.ply` directly.** Minimal bounded parser (ASCII, binary LE/
BE, x/y/z only), voxelise with unit scale and Y-up→Z-up re-orientation, morphological close,
flood-fill the exterior, everything unreached is solid. A gap wider than the closing radius
*leaks* and is reported as `closed: false`, never silently an empty shell.

**D6 — Meshing is naive surface nets, watertight by construction and checked anyway.** One
vertex per mixed cell, one quad per crossing grid edge, winding by which end is solid; optional
Laplacian smoothing with every vertex clamped to its own cell. The ocean-lab validator's edge
census, winding, area and Euler checks run on every result; `printable` is the conjunction a
slicer needs, with χ reported separately.

**D7 — The drawing is the grid re-projected, not a separate model.** Six views traced exactly
from `projectGrid`, third-angle layout, standard scale series, overall dimensions on front and
top, title block, and a notes column that carries every extent's provenance and the lane's
limitation text. Sheet and STL are two readings of one solid and cannot disagree.

**D8 — Printing is a pluggable network boundary behind the explicit-confirm gate.** OctoPrint,
Moonraker and PrusaLink adapters behind one interface (the TTS/LLM pluggability rule); the API
key rides a header and is stored only as owner-key ciphertext; base URLs refuse loopback,
metadata and credentials; slicing is a configured command run with `execFile` (never a vendor
literal, never a shell); an STL is never auto-started. `POST /jobs/:id/print` answers 428
without `confirm: true`. No bot tool can print.

**D9 — The concierge briefs; it never computes.** One inline bot with manifest-declared selector
and keywords (ADR-083), three read-only route-backed tools, a strict JSON output contract, and a
persona that quotes the report rather than inventing a measurement.

**D10 — Core is untouched.** The engine is bundled in the package (`routes/engine/`, zero
framework imports — asserted). The package uses one kernel skill, `memory`, for the vault. This
is deliberately *not* a kernel skill: the kernel-skills registry is provider abstractions, and a
domain engine's second consumer does not yet exist. The extraction trigger is a second package
needing the occupancy grid (ADR-111's spaces is the candidate, for object cut-outs of a room
scan).

## Consequences

- A person can go from six phone photos to a dimensioned drawing, a watertight STL and a job
  on their own printer with no model in the loop and a report that says what was measured, what
  was derived, what was assumed and what the method cannot see.
- A LiDAR export from an iPhone/iPad Pro (Scaniverse/Polycam `.ply`) reconstructs an object
  today through the point-cloud lane; a range-image device needs only to emit the `DepthMap`
  struct (upload endpoint and perspective re-projection are the package's BACKLOG B1/B2).
- Verification: 40 dependency-free engine cases in store-ci; a framework-coupled loopback HTTP
  suite (7 cases) registered in the package's Test Lab catalog with its checkout prerequisite;
  the canonical whole-store compile passes.
- Not built and not claimed: fiducial-based auto-scale, print progress read-back, artifact
  exchange as a source, a depth-image upload, perspective range images. Each has done-when
  criteria in `scan-to-print/BACKLOG.md`.
- The as-built contract lives with the code in `scan-to-print/docs/ARCHITECTURE.md`; this ADR
  is the decision record, and it defers to that file for numbers.
