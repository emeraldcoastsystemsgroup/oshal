# ADR-153: Iterative CAD — a real kernel the swarm drives through its own tools (the CAD Studio package)

**Status:** Accepted — **BUILT** 2026-09-12 as the store package `cad-studio` 0.1.0
(`emeraldcoastsystemsgroup/oshal-applications`, `cad-studio/`). Nothing in core changed; this
ADR records the decision because it settles what "CAD" means on this platform and how a kernel
that cannot run in the api image is owned, driven and verified by a package.
**Related:** [ADR-150](150-deterministic-object-reconstruction-scan-to-print.md) (the scan
whose outlines become a B-rep base here), [ADR-036](036-bot-owned-application-architecture.md)
(the bot owns the domain; here the bot edits a feature list and the kernel does the geometry),
[ADR-085](085-remote-app-packages-and-registries.md) (store package posture),
[ADR-090](090-skills-model.md) / [ADR-149](149-enterprise-application-authorization.md)
(route-backed package tools executed under the caller's authority), the aero-lab package's
engine container (store, 2026-09-11) whose shape this reuses.

## Context

Operator direction (2026-09-12), after Scan to Print shipped photos → drawing → STL → printer:
*"if CAD then it has to be a CAD MCP that can be controlled to do the work … I'm not looking for
a non-integrated environment … it needs to be iterative."* Three constraints:

1. **A real CAD kernel.** Not a mesh editor: B-rep solids, real fillets and shells, STEP out.
   The only open kernel that qualifies and is scriptable without a desktop is Open CASCADE
   Technology (OCCT), reached through CadQuery. Mesh-only alternatives (Manifold, JSCAD,
   OpenSCAD's CSG) are faster to embed but cannot fillet, shell or emit STEP.
2. **Controllable by the swarm ("a CAD MCP").** The kernel must be driven by tools a bot calls
   — and, through the framework's tool bridge, by any MCP client — not by a human in a GUI.
3. **Integrated and iterative.** Inside the cockpit, one model, every edit a rebuild the person
   sees immediately, the bot and the person editing the same thing, undo.

What existed: the aero-lab package's **package-owned engine container** (the api image is Alpine
and cannot host glibc-only wheels; aero-lab builds a `python:3.11-slim` image locally from PyPI
pins, joins it to the stack network under its own compose project, speaks a JSON-lines TCP
bridge with a hello carrying the engine build hash); the framework's **route-backed package
tools** (`executor: api`) executed server-side under the caller's identity by the chat
executor and exposed to MCP clients by `scripts/oshal-tools-mcp.js` over the internal tool
bridge; ADR-150's occupancy grid, whose per-view outlines are an exact description of a
scanned object.

## Decision

### The kernel choice — cost / benefit

| Option | What it gives | What it costs | Verdict |
|---|---|---|---|
| **OCCT via CadQuery, in a package-owned container** | B-rep solids; real fillet / chamfer / shell / booleans; STEP + STL + hidden-line SVG; the kernel FreeCAD uses; scriptable, deterministic | a ~400 MB image built locally at install (one command, ~5 min first time); 1–2 s per rebuild; a TCP hop | **Chosen** — it is the only option that is CAD |
| Manifold / JSCAD in-process (mesh CSG) | zero install; fast booleans on meshes | no fillets, no shells on B-rep, no STEP, a triangle soup as the model | rejected: not CAD |
| FreeCAD headless | everything OCCT plus TechDraw, sketcher constraints | ~1 GB image; a GUI application driven headless; slower start | deferred: same kernel, more weight, nothing the contract needs today |
| Cloud CAD API | no local install | credentials, egress of every model, no determinism guarantee, vendor lock | rejected: the geometry leaves the box |

### The model

- A **model** is a **base** plus an **ordered feature list**; the list is replayed whole on every
  change (parametric history). Bases: box, cylinder, sketch-extrude, **scan contours** (each
  Scan to Print view outline extruded along its viewing axis, the solid is their intersection —
  the visual hull as a B-rep, with faces a fillet can touch), and an STL mesh sewn into a solid.
  Features: hole, boss, box-add, box-cut, sketch-extrude, fillet, chamfer, shell, cut-plane,
  scale, mirror, rotate, translate.
- A **revision** is one successful rebuild: the exact list, the report, the engine build hash.
  Restoring a revision's list is undo; nothing is deleted.
- The **contract** (every parameter, unit, range, selector) lives twice — `engine/cad_worker.py`
  and `src-routes/feature-contract.ts` — and a spec asserts they name the same things. The route
  validates before the kernel runs (a typo is refused naming the field, never a silent no-op);
  a feature the kernel refuses is reported **per feature with the reason and skipped**, so an
  iterating agent always gets a buildable model back and a precise correction to make.
- **Determinism:** same base + same list → same STEP and STL bytes (the STEP header's clock and
  per-session product counter are pinned; tessellation is at a fixed tolerance).
- **Frame:** Scan to Print's — millimetres, Z up, footprint centred, resting on Z = 0, front −Y.

### The engine

- The kernel runs in the package's own container built locally from upstream
  (`engine/container/`), installed by one command the studio prints when the engine is down.
  Own compose project (a core deploy's `--remove-orphans` cannot sweep it), no host port,
  read-only root, capabilities dropped, memory cap.
- The api holds **one persistent connection** per process (the kernel stays warm between
  iterations), serialises requests, verifies the bridge **hello** (protocol + build hash of the
  package's `engine/` tree) before the first request, kills a stalled worker by closing the
  socket, reconnects on the next request. A stale or absent container is
  `capability_unavailable` with the exact install command — never a wrong model.

### How the swarm drives it (the "CAD MCP")

The manifest declares route-backed tools — capabilities, list, read, create, add / update /
remove / move feature, restore revision, rebuild. The framework executes them server-side under
the caller's identity: the inline concierge (`cad-studio-designer`) calls them from the cockpit's
chat rail, and the same registrations are what the tool bridge exposes to MCP clients. Writes are
`auto` (no click per edit) because every write touches only the caller's own list, is reversible
through revisions, and nothing leaves the box. The studio polls the open model, so an edit made by
the concierge appears without a reload. Printing stays in Scan to Print behind its confirmation.

### What is deliberately not here

No sketch constraints, assemblies, threads, text, lofts / sweeps / revolves (BACKLOG B1, B4),
no click-to-place in the viewer (B2), no send-to-print hand-off (B3). Mesh-base fillets are the
kernel's call and often refused; the report says so.

## Consequences

**Positive.** CAD on the platform is a kernel, not a mesh trick: STEP out, fillets that are
fillets, a drawing with hidden lines. The bot edits a list, never geometry, so a wrong idea is a
refused feature with a reason rather than a corrupted model. The scan → CAD bridge is exact
(outlines → B-rep) and needs no reconstruction of a mesh. The whole thing is a store package;
core is untouched.

**Negative.** Another engine container per box (one install command; the studio nags until it
is run). Rebuilds are 1–2 s, not instant. OCCT booleans on a large mesh base are slow and the
package caps it at 100 000 triangles. Two copies of the contract must be kept in step (a spec
enforces it).

**Verification shipped with it.** The real-kernel Python suite (14 cases, run in the engine
image and by the installer's self-test), the contract + build-hash suite and the transport suite
against a fake bridge (plain node, store-ci), and the framework-coupled HTTP suite with the real
engine client (registered in the Test Lab with its checkout prerequisite).
