# Spatial Capture Playbook — make a 3D map of a space with the gear you have

**Status:** As-built (ships 2026-07-20; routes are baked, live after the next deploy) across the
**import** and **reconstruct** lanes, **guided capture** + the **live phone HUD**, and the
**sim drone scan** mission. The reconstruct lane (video→3DGS) still needs a GPU box wired at
`RECON_URL` before it produces a real scene instead of the Sim synthetic room. Honest deferred list:
real-drone MAVLink media ingest, bot-personalized (vs deterministic) capture plans, live
turn-by-turn pose feedback (v3), ArUco-fiducial metric anchoring, real RSSI walk-survey capture
tooling, GoPro ingest, drone relocalization, and the drone mission-overlay handoff. Companion to
[ADR-111](../adr/111-spatial-mapping-3d-reconstruction.md) and
[spatial-mapping-pose-persistence.md](./spatial-mapping-pose-persistence.md).

## Two lanes into `?app=spaces`

OSHAL does **not** reimplement each device's scanner. Every capture device exports a **standard 3D
file**, and OSHAL ingests it. There are exactly two ways in:

| Lane | Route | Input | Needs a GPU box? | Best for |
|---|---|---|---|---|
| **Import** *(new)* | `POST /api/spaces/scans/import` (field `model`) | a pre-built `.ply` or `.splat` | **No** | iPhone/iPad LiDAR, depth cameras, any app that already outputs a 3D file |
| **Reconstruct** | `POST /api/spaces/scans` (field `video`) | a walkthrough video | **Yes** (`RECON_URL`) | phones/drones with only video; highest visual fidelity |

Both land as an owner-scoped scan you walk in the cockpit's WebGL viewer. The import lane converts
your file to the viewer's `.splat` format on the spot (point cloud → one small gaussian per point;
a trained-3DGS `.ply` → mapped directly).

## Pick your device

### 📱 iPhone / iPad **Pro** — LiDAR (the fastest real map)
Pro models (iPhone 12 Pro and later, iPad Pro 2020+) have a **LiDAR scanner** — depth is **metric**
out of the box, no fiducial needed.
1. Scan with **Polycam** or **Scaniverse** (both free tiers work).
2. Export **`.ply`** — either the **point cloud** or, in newer versions, a **Gaussian Splat `.ply`**.
   Both import.
3. Upload it at `?app=spaces` → **Import**. Done — your real room, in the viewer, no GPU.

### 🤖 Android — mostly **no** LiDAR
Only a few phones ever shipped a depth (ToF) sensor and Samsung dropped it; there's no standard
Android LiDAR. Two working paths:
- **Polycam (photo mode)** or another photogrammetry app → export `.ply` → **Import** lane.
- Or film a slow walkthrough **video** → **Reconstruct** lane (once `RECON_URL` is wired).
ARCore's Depth API gives depth-from-motion for apps, but you still export a standard file to import.

### 🚁 Drone (camera)
Best for larger spaces / exteriors.
- If your ground app produces a **mesh/point cloud** (`.ply`), **Import** it directly.
- Otherwise **save the video to a file** and use the **Reconstruct** lane. Capture is your one shot —
  see [Capture technique](#capture-technique-photogrammetry--3dgs) below, and **drop a known-size
  marker in frame** if you want metric scale.
- **Sim drone scan (built, sim-only):** `POST /api/spaces/drone-scan` flies an overlap-derived orbit
  (`droneScanPattern`) on a virtual-clock SimDroneProvider and registers a `sim-mission` scan through
  the reconstruction pipeline — a working demo of drone-as-capture with no aircraft. Real-drone media
  ingest (MAVLink follow-up) is not built yet; a physical drone today still goes through the Import
  (ground-app mesh) or Reconstruct (saved video) paths above.

### 🎯 Depth cameras (Intel RealSense, Azure Kinect)
Capture a colored point cloud (`.ply`) with the RealSense Viewer / RecFusion / Open3D, then
**Import** it. Metric by construction.

### 📡 mmWave radar / "router as sonar" — *not an app path*
RF does **not** produce room geometry on commodity hardware (see ADR-111). WiFi CSI senses **people
and motion**, not walls; a 60 GHz mmWave radar gives only a **coarse point cloud**. If you export a
radar point cloud as `.ply` it will import, but treat it as a sparse overlay, not a map. RF is not a
capture path, but Spaces does ship an RF/Wi-Fi *coverage overlay* you can paint onto an already-built
scan (`POST /api/spaces/scans/:id/rf`) — room-level, and always an overlay, never geometry.

## What the import lane accepts

- **Extensions:** `.ply` (ASCII or binary; point cloud **or** trained 3DGS) and `.splat` (passthrough).
- **Size:** up to **300 MB** per file.
- **Cap:** the viewer is capped at **2,000,000 gaussians** — larger inputs are **stride-subsampled**
  (and the drop is logged, never silent).
- **Colour:** point clouds use `red/green/blue` (or `r/g/b`); 3DGS `.ply` uses `f_dc_*` spherical-
  harmonics colour, `scale_*` (log), `opacity`, and `rot_*` quaternion.
- **Meshes:** a mesh `.ply`'s **vertices** render as a point cloud; faces aren't sampled yet
  (documented follow-up, not a silent gap).
- **Metric scale:** a LiDAR/depth capture is already metric. A photogrammetry/video capture is
  scale-free unless you included a **known-size fiducial** (an ArUco marker, or a measured object) —
  and that must be present **during capture**; it can't be added later.

### Import via API (example)

```bash
curl -sS -X POST "$OSHAL/api/spaces/scans/import" \
  -H "Cookie: $AUTH" \
  -F "title=Living room" \
  -F "model=@living-room.ply;type=application/octet-stream"
# -> 201 { "scan": { "id": "...", "status": "queued", "sourceKind": "model", ... } }
# poll GET /api/spaces/scans/:id until status:"ready", then GET .../artifact for the .splat
```

## Capture technique (photogrammetry / 3DGS)

For the video/photo routes (the flight is your one shot — reconstruction is offline/batch):
1. **Slow and smooth** — motion blur is the #1 killer of the COLMAP feature solve.
2. **70–80% overlap** between frames; overlapping lawnmower passes **plus** an orbit of key objects.
3. **Every surface from 2+ angles.** Texture-less blank walls hole out — graze them or accept gaps.
4. **Lock exposure** if you can.
5. **Metric scale is now-or-never:** include a known-size object in view (see above).

### Or let OSHAL guide you — guided capture (built)
Instead of remembering the rules above, call `GET /api/spaces/capture-plan?target=room|large-room|object|facade`;
it returns a deterministic step-by-step filming plan (where to stand, how far to sweep, overlap
targets), rendered as a step-through panel on the `?app=spaces` surface. Plans are deterministic per
target today; bot-personalized plans are roadmap.

### Live phone HUD (built, v1)
Open `?app=spaces` → guided capture, or `GET /api/spaces/capture`, to film with a live on-screen HUD:
WALK chevrons tell your feet where to go, a PAN ring tells the camera where to point, and a warning
fires if you pan too fast (motion blur is the #1 COLMAP killer). Sensor telemetry
(heading/sweep/steps/GPS) posts to `/api/spaces/capture-telemetry`. Needs a user gesture + HTTPS
(iOS sensor prompts). v1 is sensor-driven against the plan; live pose/coverage feedback (v3) is
roadmap.

## Where each lane stands

- **Import lane:** built, guarded (`tests/unit/spatial-import.spec.ts`), no external dependency.
  The active app-store package serves the route, viewer, and surface from its own package root.
- **Reconstruct lane:** built end-to-end. The GPU-box service now exists in-repo at
  [`scripts/spatial-recon-edge/`](../../scripts/spatial-recon-edge/README.md) (stdlib HTTP server +
  the real `ffmpeg→COLMAP→splatfacto→.splat` pipeline; protocol + converter verified). Deploy it on
  a CUDA box and set `RECON_URL`, and an uploaded video reconstructs your **real** space; unset, the
  **Sim** provider serves a synthetic room. Standing it up on your hardware is the last step.
- **Guided capture:** built, guarded (`tests/unit/spatial-capture-plan.spec.ts`). Plans are
  deterministic per target and the installed Spaces package mounts the route; bot-personalized
  plans are roadmap.
- **Live phone HUD:** built in `oshal-applications/spaces/tools/spaces-capture.html` and served at
  `/api/spaces/capture` with `/api/spaces/capture-telemetry`. v1 is sensor-driven against the plan;
  live pose feedback (v3) is roadmap.
- **Sim drone scan:** built, guarded (sim flight covered by `tests/unit/spatial-capture-plan.spec.ts`),
  sim-only. Real MAVLink media ingest is deferred.
