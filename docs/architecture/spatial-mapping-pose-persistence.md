# Spatial Mapping — Pose Persistence → RF Coverage Overlay → Drone Relocalization

**Status (2026-07-20):** Increments **A (pose persistence)** and **B (RF coverage overlay)** are
**BUILT** with unit guards (commits `14493815`/`51915169`/`1cd1b919` + the same-day audit-fix
hardening pass); increment **C (drone relocalization contract)** remains design-only. Follow-on to
[ADR-111](../adr/111-spatial-mapping-3d-reconstruction.md) (video→3DGS spine, Phase 1 built +
runtime-verified). As-built deviations from this spec: the RF overlay lives **inside the
`spatial-mapping` slice** (FSD forbids the cross-slice import a separate `rf-overlay` slice would
need), and RF samples/results **and pose data** persist as **owner-scoped on-disk sidecars**, not a
Postgres table.
The spec text below is kept as the design record, grounded in verified external sources (cited
inline).

> **Research provenance.** The technique/format claims in §3–§5 were fact-checked via a 5-angle
> deep-research fan-out (24 sources, 105 extracted claims, 23 confirmed under 3-vote adversarial
> verification, 2 over-claims killed). Killed claims are called out so they don't creep back in.

---

## 1. The one unlock: persist camera poses in a known frame

Everything the operator asked for — *"triangulate the signals / understand where they're coming
from"* and *"help the drone navigate"* — reduces to one missing artifact: **persisted per-frame
camera poses in a known (ideally metric, gravity-aligned) world frame.**

The pipeline **computed these poses and Phase-1 discarded them.** COLMAP's entire structure-from-motion
stage solves a world-to-camera pose per frame; increment A (now built) persists them via
`EdgeReconstructionProvider.fetchPoses()` + the `poses.json` sidecar. Persist them once and three
capabilities open up:

| Capability | Why poses are the hard precondition |
|---|---|
| **RF coverage / source-finding overlay** | An RSSI reading is meaningless without *where in the scene* it was taken. `{pose → RSSI}` pairs → path-loss localization of the transmitter + an interpolated coverage/dead-zone volume painted on the splat. ADR-111 explicitly defers this **"until poses exist."** |
| **Drone relocalization** | A drone re-entering a mapped space relocalizes a single query image against the stored reconstruction, then flies in the scene's real frame. |
| **Multi-scan alignment (house = linked rooms)** | A shared metric frame lets separate room scans register into one house model — ADR-111's stated ">8GB-VRAM → multiple linked scans" path. |

The fix is **additive**, not a rewrite, and rides the existing engine-agnostic
`ReconstructionProvider` contract (sim + edge satisfy one interface).

---

## 2. Pre-increment-A baseline (Phase-1 slice)

> **Superseded by §3.** This section records the state *before* increment A; `ReconstructionArtifact`
> now carries an optional `poses?: ScanPoses` (§3.2).

- `ReconstructionArtifact` returned only `{ splat, gaussianCount, providerKind, meta? }` — **no poses,
  no world frame** ([spatial-types.ts](../../src/features/spatial-mapping/model/spatial-types.ts)).
- `.splat` is geometry-only: pos/scale/color/quat per gaussian, no header, no trajectory
  ([splat-format.ts:6](../../src/features/spatial-mapping/services/splat-format.ts#L6)).
- The Edge box runs `ffmpeg→COLMAP→splatfacto→export` and only the splat is fetched
  ([edge-reconstruction-provider.ts:6,70-82](../../src/features/spatial-mapping/services/edge-reconstruction-provider.ts#L70-L82)).
- `SpatialScan` has no pose/frame columns
  ([spatial-types.ts:27-42](../../src/features/spatial-mapping/model/spatial-types.ts#L27-L42)).

---

## 3. Increment A — Pose persistence (the unlock)

### 3.1 The coordinate-frame facts you must get right (verified)

This is where naive implementations silently produce poses that float off the splat. The verified
conventions:

- **COLMAP `images.txt`** — each image's first line is `IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID
  NAME`, and this pose is the **world-to-camera** projection (NOT camera-to-world).
  [colmap.github.io/format.html]
- **Camera center in world coords** = `C = -R^T · T`, where `R` is the rotation from the quaternion
  `(QW,QX,QY,QZ)` and `T = (TX,TY,TZ)`. This is the inversion you store as the camera position.
  [colmap.github.io/format.html]
- **`cameras.txt`** carries intrinsics (model + `fx,fy,cx,cy`, width, height) — persist these; PnP
  relocalization (§5) needs them.
- **COLMAP uses the OpenCV camera convention; Nerfstudio/splatfacto uses OpenGL/Blender** (+X right,
  +Y up, +Z back). Converting COLMAP→Nerfstudio **flips the Y and Z axes, keeps +X**.
  [docs.nerf.studio/quickstart/data_conventions.html] — if the overlay/relocalization code assumes
  one convention and the viewer renders in the other, everything is mirror-flipped.
- **The trained splat sits in the COLMAP world frame at initialization** — splatfacto seeds gaussians
  directly on COLMAP's sparse 3D points [docs.nerf.studio/nerfology/methods/splat.html].
  **Caveat RESOLVED in code (2026-07-20 audit-fix):** Nerfstudio's dataparser applies an
  auto-orient/center/scale transform (`dataparser_transforms.json`) and `ns-export gaussian-splat`
  does **not** undo it (verified against nerfstudio's exporter on the pinned toolchain) — so the
  exported splat lives in the *training* frame. `scripts/spatial-recon-edge/pipeline.py` now writes
  poses **after** training, pre-multiplying every pose by the run's dataparser transform + scale
  (`poses.py:_apply_dataparser`, guarded in `test_recon.py`); if `dataparser_transforms.json` is
  missing, poses are skipped rather than persisted frame-divergent.
- **The `.splat` byte layout is NOT documented in the antimatter15 README** — it comes from the
  converter source [github.com/antimatter15/splat]. We already encode it correctly in `splat-format.ts`
  (32-byte stride); keep that file the single source of truth for the format.

### 3.2 Contract (additive — does not break Phase 1)

New types ship in `model/pose-types.ts`; `spatial-types.ts` re-uses them via the optional `poses?`
field on `ReconstructionArtifact`:

```ts
/** One keyframe's camera pose + intrinsics, expressed in `WorldFrame`. */
export interface KeyframePose {
  index: number;
  imageRef: string | null;          // stored frame (for relocalization) or null
  center: [number, number, number]; // camera-to-world center C = -R^T T
  quat: [number, number, number, number]; // camera orientation, wxyz
  fx: number; fy: number; cx: number; cy: number; // pinhole intrinsics (px)
  width: number; height: number;
}

/** The frame poses + splat share. Named so downstream never guesses. */
export interface WorldFrame {
  convention: 'opencv' | 'opengl';  // MUST match what the viewer renders
  metric: boolean;                  // true = meters
  scaleSource: 'none' | 'fiducial' | 'arkit' | 'realsense' | 'device-poses' | 'manual';
  scale: number;                    // multiply raw COLMAP units by this → meters
  gravityAligned: boolean;
  upAxis: 'x' | 'y' | 'z';
}

export interface ScanPoses { scanId: string; frame: WorldFrame; keyframes: KeyframePose[]; }
```

`ReconstructionArtifact` gains an **optional** `poses?: ScanPoses` (optional = Phase-1 outputs that
emit no poses stay valid). The service writes a `poses.json` sidecar next to the `.splat` (same
owner-scoped scan dir via `scan-paths.ts`); pose presence is detected by the `poses.json` sidecar's
existence (no Postgres column was added) — same on-disk-sidecar posture as the RF results (bytes stay
on disk per ADR-041).

### 3.3 Edge provider — export COLMAP poses

The GPU box already has `sparse/0/images.txt` + `cameras.txt`. Add a box-side export that emits
`poses.json` (apply the §3.1 inversion + frame transform there, where COLMAP's own libs are
available) and a `GET /jobs/{id}/poses` endpoint; `EdgeReconstructionProvider` fetches it alongside
the splat and returns `artifact.poses`.

### 3.4 Sim provider — synthetic poses

`generateRoomSplat` is deterministic; add a sibling `generateRoomPoses(seed)` emitting a plausible
orbit/lawnmower keyframe path around the same synthetic room (same seed → same poses). This keeps the
**entire** downstream (overlay, relocalization) exercisable with **no GPU**, exactly as the sim splat
does today.

### 3.5 Metric + gravity anchoring (honest options, ranked)

COLMAP is scale-free and not gravity-aligned by default. Verified anchoring paths, cheapest-first:

1. **Known-size fiducial (recommended default real anchor).** Place an ArUco marker of known edge
   length in the scan; `aruco-estimator` recovers metric scale + registration automatically
   (`--aruco-size 0.15` = a 15 cm marker, in meters). [github.com/meyerls/aruco-estimator]
2. **Device metric poses fed in** (ARKit/ARCore/RealSense) via COLMAP **geo-registration**: supply
   3D world locations for camera centers (Cartesian or GPS) → a 3D similarity transform to that
   frame. [colmap.github.io/faq.html]
3. **Gravity alignment without a fiducial:** COLMAP can auto-determine the gravity axis + major
   horizontal axis via **Manhattan-world vanishing-point detection**. [colmap.github.io/faq.html]
4. **Visual-inertial** joint scale/gravity/bias estimation (match visual vs inertial acceleration
   under `|g|=9.8`) is real and gravity-aligns the model. [arxiv:1611.09498]

> **KILLED (do not claim):** "IMU + monocular SfM recovers metric scale to ~1% error" was **refuted
> 0-3**. Treat IMU scale as *approximate*; use a fiducial or device poses when metric accuracy
> matters.

**Honest default:** ship `scaleSource:'none'` (arbitrary units, viewer still walks the scene), and
light up metric mode the moment a fiducial or device poses are present. Never render a metric ruler
on an unanchored scene.

### 3.6 Guards (guard-per-fix)

- `tests/unit/spatial-poses.spec.ts` — a provider returning poses round-trips through `poses.json`
  with exact keyframe count + frame metadata; a fixed `images.txt` line inverts to the expected world
  center (`C = -R^T T`) and the OpenCV↔OpenGL flip is asserted in both directions; owner-scoping —
  `GET /api/spaces/scans/:id/poses` 403s a non-owner, 404s pre-`ready`.
- Keep `/api/spaces` on the route-auth inventory guard.

---

## 4. Increment B — RF coverage overlay (lives inside the spatial-mapping slice — see header deviation)

RF coverage lives **inside** the `spatial-mapping` slice (a separate `src/features/rf-overlay/**`
slice would need a forbidden cross-slice import — see the header deviation). It *consumes* a
ready scan's `poses.json` + `.splat`. This is the honest, real form of the operator's original
"map the signals in the home" idea; it paints RF onto geometry that came from video, and makes **no
geometry claim from radio** (honors ADR-111 §Decision-1).

### 4.1 Sample store (owner-scoped)

`RfSample = { scanId, sub, keyframeIndex | pose, bssid|beaconId, ssid?, rssiDbm, band, ts }`.
**As built, samples/results persist as owner-scoped on-disk sidecars next to the scan (not the
`user_sub`-keyed RLS table this design record first proposed).** Samples come from a phone/ESP32
walked through the space while filming (timestamp-align RSSI to keyframe poses), or from a drone
logging RSSI at its VIO poses during a scan mission (Phase-3 tie-in).

### 4.2 Transmitter localization + coverage volume (verified technique)

- **Path-loss model:** `RSSI = P0 − 10·n·log10(d/d0)`; `n ≈ 2` in free space, rising with obstacles.
  Fit `n`/`P0` from the samples, or fall back to `n = 2.0` when the environment defeats fitting.
  [ceur-ws.org/Vol-2590/paper32.pdf]
- **Locate the transmitter:** with ≥4 `{pose → RSSI}` samples (`MIN_TX_SAMPLES=4` — the fit solves
  four unknowns: `x,y,z,txPower`), convert RSSI→distance via the model and multilaterate the
  transmitter position (router/BLE beacon).
- **Coverage/dead-zone volume:** interpolate the sparse `{pose → RSSI}` set over the scene.
  **Kriging** on a WiFi RSSI database gives synthetic RSS within 3 dBm ~72% of the time (per-AP MAE
  1.77–3.09 dBm) — viable densification [ncbi PMC4610440]; IDW is the cheaper first cut. Fusing a
  SLAM point cloud + camera trajectory + per-pose RSSI into a 3D coverage map is an established
  method [ceur-ws Vol-2590/paper32] (weaker source, 2-1). Render the result as a second gaussian
  layer colored by interpolated RSSI + a marker at each estimated transmitter.

### 4.3 The honesty guardrails (verified — keep the claims small)

- **Realistic accuracy:** a calibrated ESP32-S3 RSSI ranging rig (log-normal shadowing + sliding
  median filter W=11) hit **MAE 1.45–1.95 m**, RMSE 1.79–2.32 m, 90th-percentile < 3.6 m
  [science.lpnu.ua …csi-and-rssi]. So the overlay is **room/zone-grade**, not centimeter — exactly
  the ceiling ADR-111 assumed.
- **The multipath killer:** in a confined 3×8 m room, constructive multipath **collapsed the RSSI
  gradient to ~3 dBm across 1–5 m**, making empirical path-loss-exponent fitting unreliable
  [science.lpnu.ua]. Surface this in the UI — small rooms may not range at all; fall back to
  room-level fingerprinting.
- **CSI vs RSSI:** WiFi CSI exposes amplitude, phase, and delay per subcarrier — far richer than
  scalar RSSI, enough to sense breathing/chewing in a static room [github.com/espressif/esp-csi].
  **KILLED (do not claim):** "CSI requires ESP32 / all ESP32 support CSI" was **refuted 0-3** — CSI
  is available on multiple chipsets (Intel 5300, Atheros, Nexmon-patched Broadcom, and ESP32 among
  them); don't state ESP32-exclusivity or blanket ESP32 support.

### 4.4 The bot owns it (ADR-036)

Reasoning — dead-zone critique, "move your router here", coverage summary — runs on the
`spaces-operator`/`space-mapper` concierge as LLM work with cost in `chat_tasks`. The overlay slice
is deterministic I/O; the bot narrates it.

### 4.5 Guards

- `tests/unit/spatial-rf.spec.ts` — synthetic transmitter at a known point + noiseless samples at
  known poses → multilateration recovers it within tolerance; asserts **both** a graceful no-throw
  path below the `MIN_TX_SAMPLES=4` floor **and** the ≥4-sample transmitter-fit floor; the sample
  store + overlay route are owner-scoped.

---

## 5. Increment C — Drone relocalization hook (contract, not a flight stack)

### 5.1 What to persist so a companion computer can relocalize later (verified)

Structure-based **hierarchical localization (hloc)** is the reference pipeline: **global retrieval
(NetVLAD) → local feature matching (SuperPoint + SuperGlue/LightGlue) → PnP** against a stored SfM
model [github.com/cvg/Hierarchical-Localization]. What it needs persisted from the reconstruction:

- the **COLMAP/pycolmap SfM model** (triangulated 3D points + camera poses + intrinsics), and
- **per-keyframe local keypoints/descriptors** (hloc stores these in HDF5) + the keyframe images (or
  their global descriptors). [github.com/cvg/Hierarchical-Localization]

This decides `KeyframePose.imageRef` semantics: store enough to recompute descriptors (downsampled
keyframe images) *or* precomputed descriptors — a size/latency trade to make when Increment C lands.

**Direct-in-3DGS relocalization is now viable** and worth tracking: **GS-CPR / GSLoc**
(arxiv:2408.11085) is a test-time pose-refinement framework that uses the trained 3DGS as the scene
representation — it takes a single RGB query + a coarse initial pose, **renders synthetic RGB+depth
from the splat**, and forms 2D-3D correspondences to refine the pose. That means **our persisted
splat itself becomes a relocalization asset**, not just a viewer artifact.

### 5.2 Onboard-VIO ↔ offboard-map boundary (firm)

Live flight navigation runs **onboard** the drone's companion computer in real time — visual-inertial
state estimation and obstacle avoidance (ORB-SLAM3, VINS-Fusion, OpenVINS class). A backend supplies
the **prior map, global relocalization, and the mission** — the same onboard-lightweight /
offboard-heavy split used for indoor aerial mapping [cdcl.umd.edu/papers/scitech25b.pdf, AIAA SciTech
2025]. **Do not put a flight-control loop behind an OSHAL HTTP poll.** OSHAL's role stays: build the
map (ADR-111), serve the relocalization asset (§5.1), and orchestrate the mission (ADR-098/099).

**Minimal drone↔backend contract:** backend → drone: `{ splat, poses.json, (optional) SfM points +
keyframe descriptors, mission }`. drone → backend: `{ posed keyframes / video, telemetry, scan
status }`. Real drone media ingestion stays gated on the MAVLink follow-up ADR-111 already names.

---

## 6. Sequencing + collision-safe execution

1. **Coordinate first.** Post a COLLABORATE claim scoped to: NEW `model/pose-types.ts`, NEW
   `src/features/rf-overlay/**`, NEW migration, NEW routes (append-only to `routes/index.ts`, the
   same pattern `@spatial-mapping-build` used), NEW guard specs, this doc + its README pointer.
   Explicitly **do not** edit `@spatial-mapping-build`'s in-flight files; the `poses?` field is
   merged onto `ReconstructionArtifact` only after that claim releases (or by that lane, coordinated).
2. **A → B → C.** Pose persistence is the hard dependency; RF overlay and relocalization both consume
   it. Land A green with guards, then B, then C (C is a contract + persisted-data decision, not a
   flight stack).
3. **Rule 0a discipline** — explicit pathspecs, verify the COMMIT (archive-tsc), `main` green at each
   checkpoint, guards in the same commit.
4. **Promotion.** When A+B land and prove out, this spec is a candidate to promote to a numbered ADR
   (next free number was 112 at authoring) or fold into ADR-111 as its Phase-1.5.

---

## 7. Done-when

- **A:** a `ready` scan serves `GET /api/spaces/scans/:id/poses` with valid camera-to-world keyframe
  poses in a named frame; the sim path works with no GPU; the `C = -R^T T` + OpenCV↔OpenGL guard is
  green.
- **B:** given `{pose → RSSI}` samples for a ready scan, the viewer shows a coverage/dead-zone layer +
  an estimated transmitter marker; the localization guard recovers a synthetic transmitter within
  tolerance; the UI states the room-level accuracy ceiling and the small-room multipath caveat.
- **C:** the drone↔backend relocalization data contract is documented, the persisted-data list is
  finalized (`imageRef` semantics decided), and **no** flight-control code was added to the
  controller.

---

## Sources (verified)

- COLMAP output format (images.txt/cameras.txt, world-to-camera, `C = -R^T T`) — https://colmap.github.io/format.html
- COLMAP FAQ (geo-registration, Manhattan gravity axis) — https://colmap.github.io/faq.html
- Nerfstudio data conventions (OpenGL frame; Y/Z flip vs COLMAP) — https://docs.nerf.studio/quickstart/data_conventions.html
- Nerfstudio splatfacto (gaussians seeded on COLMAP points) — https://docs.nerf.studio/nerfology/methods/splat.html
- antimatter15/splat (.splat layout is in converter source, not the README) — https://github.com/antimatter15/splat
- aruco-estimator (known-size fiducial → metric scale) — https://github.com/meyerls/aruco-estimator
- Visual-inertial scale + gravity + bias estimation — https://arxiv.org/pdf/1611.09498
- Kriging over a WiFi RSSI database (radio-map densification) — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4610440/
- Log-distance path-loss model + SLAM-fused RSSI coverage cloud — https://ceur-ws.org/Vol-2590/paper32.pdf
- ESP32-S3 CSI+RSSI indoor ranging (accuracy numbers; multipath-gradient collapse) — https://science.lpnu.ua/ictee/all-volumes-and-issues/volume-6-number-1-2026/design-and-experimental-evaluation-csi-and-rssi
- Espressif esp-csi (what CSI adds over RSSI) — https://github.com/espressif/esp-csi
- hloc — hierarchical localization (NetVLAD/SuperPoint/SuperGlue; persisted HDF5 + SfM) — https://github.com/cvg/Hierarchical-Localization
- GS-CPR / GSLoc (relocalize directly inside a 3DGS map) — https://arxiv.org/abs/2408.11085
- Indoor aerial 3D mapping — onboard/offboard split (AIAA SciTech 2025, UMD CDCL) — https://cdcl.umd.edu/papers/scitech25b.pdf
