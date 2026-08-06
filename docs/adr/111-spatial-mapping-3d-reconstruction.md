# ADR-111: Spatial Mapping — video→3D scene reconstruction; capture nodes are swappable; RF is an overlay, not a mapper

**Status:** Accepted — **Phase 1 + follow-on increments BUILT + runtime-verified** (through 2026-07-20).
Shipped: video→3DGS (sim + edge provider), in-repo box reconstruction service, direct import lane
(`.ply`/`.splat`, no GPU), pose persistence, RF coverage overlay, guided capture plan + live phone-HUD
capture, and a sim-first drone scan mission. Roadmap (NOT built): GPU-box deployment, GoPro/real-drone
media ingest, MAVLink follow-up, ArUco metric anchoring, real RSSI walk-survey capture, drone relocalization.
Phase 1 ships the full spine: the `spatial-mapping` slice (owner-scoped scan store + `ReconstructionProvider` with a Sim + an Edge engine), the `/api/spaces` routes, the `spaces-operator` bot, the `?app=spaces` surface, and a self-contained WebGL splat viewer. End-to-end proven against Postgres (upload → queued → reconstructing → ready → a valid owner-scoped 32-byte `.splat`); goes live in the cockpit on the next deploy (the route is already live via the hot-swap override).
**Related:** [ADR-098](098-drone-ops-app.md) / [ADR-099](099-drones-as-remote-swarm-nodes.md) (drone
nodes — the future autonomous capture platform), [ADR-036](036-bot-owned-application-architecture.md)
(bot owns the domain), [ADR-041](041-per-user-storage-targets.md) (artifact storage),
[ADR-085](085-remote-app-packages-and-registries.md) (carve posture), [ADR-097](097-app-suites-primary-categorization.md)
(suite), [ADR-110](110-jarvis-media-input-vision-as-transcription.md) (vision-describe — a sibling
media transform, not this pipeline).

## Context

Operator vision (2026-07-19): produce a **digital 3D rendering of a physical space** — a room,
then a house, eventually hostile environments (underwater, space) — with three candidate
approaches on the table:

1. **RF/router-interference mapping** (as seen in online demos);
2. **Image/video photogrammetry** — recreate a 3D space from ordinary camera footage;
3. **A mini drone controlled by a mapper** that autonomously scans the space.

### Honest assessment of the three paths

**RF sensing does not produce room geometry on commodity hardware.** The real research (WiFi
Channel State Information sensing: through-wall person detection, coarse pose estimation) requires
chipsets with CSI-exposing firmware and multiple synchronized transceivers, and its output is
human-silhouette-grade occupancy — not walls, furniture, or structure. The viral "map your house
from your router" videos are 2D received-signal-strength heatmaps presented as more than they are.
Building our mapper on this would be building on a demo. What *is* real and cheap: once a 3D model
with known camera/device poses exists, logging RSSI at those poses yields a **signal-strength
volume painted onto the model** — genuinely useful (dead-zone finding, AP placement) and honest.

**Video→3D reconstruction is mature, open-source end to end, and we already own every rail it
needs.** The modern pipeline is photogrammetry → **3D Gaussian Splatting (3DGS)**: video → frame
extraction → camera-pose solve (COLMAP structure-from-motion; newer feed-forward models like
MASt3R/VGGT can replace it for speed) → splat training (gsplat / Nerfstudio `splatfacto`) → a
`.ply`/`.splat` artifact rendered **in real time in the browser** by a small self-contained WebGL
viewer. Room-scale scenes train on consumer GPUs.

**The drone-mapper is the right end state, phased.** ADR-098/099 already give us mission planning,
draft→approve→execute doctrine, and drones-as-swarm-nodes (sim-first). The gap is bytes, not
architecture.

### What exists today (as-built inventory)

- **Drone nodes carry no media.** `CameraCapture` (drone) is shot *parameters* only; the surface
  states "real image ingestion is a MAVLink follow-up". Live video is a pass-through
  `DRONE_VIDEO_URL` the node itself serves.
- **Camera Ops drives GoPros but never pulls files.** The provider records the on-camera SD path
  from `GET /gopro/media/last_captured`; clips stay on the card. Open GoPro's HTTP API has media
  list + download endpoints, so closing this is incremental, not architectural.
- **The GPU edge-worker pattern is live-proven.** The ComfyUI edge node (RTX 4060 over Tailscale)
  already runs long generation jobs off the request path via submit→poll→fetch
  (`comfyui-provider.ts`, 10-min poll ceiling). Reconstruction is the same shape with a different
  engine.
- **Artifact storage rails exist** (ADR-041 storage targets; owner-scoped Postgres rows for
  metadata). There is no drone/camera media store today — this ADR introduces the first one.

## Decision

1. **Photogrammetry/3DGS is the mapping engine. RF is never the mapper.** The product is
   *video in → walkable 3D scene out*. The RF idea is built as an **overlay** (increment B): RSSI
   sampled at known poses is fit by router multilateration and painted as a coverage heat volume on
   the splat — room-level, never geometry. RF stays an overlay on an existing scene, never a mapper.
   No CSI hardware, no geometry claims from radio.

2. **Reconstruction is a GPU edge-worker job behind an engine-agnostic provider interface.**
   A `ReconstructionProvider` contract (submit scan → poll status → fetch artifact) with the
   first implementation driving a reconstruction service on the existing GPU box (COLMAP +
   gsplat/Nerfstudio; MASt3R/VGGT-style feed-forward pose solving is a swappable stage, not a
   rewrite). *As-built (updated 2026-07-20):* BOTH halves are in-repo — the edge client
   (`edge-reconstruction-provider.ts`) and the box-side service it drives
   ([scripts/spatial-recon-edge/](../../scripts/spatial-recon-edge/README.md): stdlib HTTP +
   ffmpeg→COLMAP→splatfacto pipeline + frame-reconciled poses + `RECON_TOKEN` auth + job
   reaping). Deploying it on the GPU box and closing one real video end-to-end is the
   remaining operator step (BACKLOG); until then the sim provider carries the local demo. Mirrors the ComfyUI provider pattern exactly: long jobs never run on the api, the
   controller never does the compute, and swapping engines is one new sibling adapter. The GPU
   box is a remote compute node (Tailscale), not a compose container — an 8GB-VRAM card bounds
   scene size (room-scale fine; a house = multiple linked scans or capped resolution), and that
   bound is stated in the surface, not hidden.

3. **Capture nodes are swappable sources feeding one pipeline.** This is the load-bearing
   abstraction — it is what makes "room today, ocean floor later" a capture-hardware upgrade
   instead of a new system:
   - **Phase 1 — handheld.** Walk the space filming with a phone/GoPro; upload the video. No new
     hardware, proves the full spine (upload → frames → poses → splat → viewer). Poses persist as a
     `poses.json` sidecar (frame-reconciled with the dataparser transform) and are served at
     `GET /scans/:id/poses` — the foundation the RF overlay stands on.
   - **Phase 2 — capture assist, then GoPro media ingest.** *First increment shipped — Guided
     Capture:* deterministic capture plans per room / object / facade (`generateCapturePlan`,
     `GET /capture-plan`) plus the installed package's live phone-HUD capture surface
     (`spaces/tools/spaces-capture.html`, served at `/api/spaces/capture`,
     `POST /capture-telemetry`) that turns compass + motion into WALK-vs-PAN
     guidance arrows, with owner-scoped telemetry. Still deferred: GoPro media ingest — the camera
     node pulling captured files off the SD via Open GoPro media list/download so `CameraCapture`
     gains real bytes landing in the media store (the known bytes gap, benefiting Camera Ops
     generally, not just mapping). Bot-personalized (vs deterministic) plans and live turn-by-turn
     pose feedback are still-roadmap follow-ups.
   - **Phase 3 — drone scan missions.** *Sim half shipped:* an overlap-derived scan pattern
     (`droneScanPattern` — orbit / lawnmower with overlap targets) flies as a mission on a
     virtual-clock `SimDroneProvider` (`POST /drone-scan`, `ScanSourceKind` `'sim-mission'`),
     proving autonomy before hardware per ADR-099. Remaining Phase-3 work (NOT built): real-drone
     MAVLink media ingest and the drone mission-overlay handoff into the ADR-098 draft→approve→
     execute doctrine. Multi-drone splits scan sectors over the mesh.
   - **Later (roadmap talk only, not scoped here):** underwater (the GoPro already in the fleet
     is waterproof to 10 m; an ROV is just another device node per the ADR-099 pattern) and other
     hostile environments. Same pipeline, different capture node — by design.

4. **The bot owns the domain (ADR-036).** A `spaces-operator` bot owns scans end to end: a
   `user_sub`-keyed scan store (scan rows, capture manifests, job state, artifact references),
   reconstruction-job orchestration, and any reasoning (scan-quality critique, rescan-path
   suggestions) as LLM work on the bot with cost in `chat_tasks`. Splat/video **bytes** never go
   in Postgres rows (they are tens–hundreds of MB — not BYTEA); Postgres holds metadata +
   ownership only. *As-built (Phase 1):* bytes live on local disk under the owner-scoped scan
   root (`OSHAL_SPACES_ROOT`, per-sub hashed dirs — `scan-paths.ts`), not behind the ADR-041
   storage-target abstraction: current targets don't fit 100MB+ binaries (oshal-local has a
   250MB quota; the git target excludes large blobs). Routing scan bytes through a
   large-binary storage target is deferred — tracked in [BACKLOG.md](../BACKLOG.md). The cockpit surface (`?app=spaces`) is a
   **view** over the bot's store: scan list, job progress, and a self-contained WebGL splat
   viewer (vendored, no CDN) to walk the model in the browser.

5. **Packaging: build in-repo first, carve when stable (ADR-099 sequencing precedent).** Suite
   `ai-home` (who it serves: a person mapping their own space — ADR-097, exactly one shelf).
   Likely eventual cut: pipeline/provider contract → kernel; surface + persona + routes →
   the store package. Auth posture is the standard one: every route auth-gated, media store
   owner-scoped, device nodes hold no vendor keys.

## Consequences

- **Phase 1 has the shortest honest path to a demo** and touches no drone code: an upload route +
  scan store, the provider pair (sim + edge client) plus the box-side reconstruction service now
  in-repo ([scripts/spatial-recon-edge/](../../scripts/spatial-recon-edge/README.md):
  ffmpeg→COLMAP→splatfacto + `RECON_TOKEN` auth + job reaping), and the viewer surface; only
  deploying it on the GPU box and closing one real video end-to-end is deferred to
  [BACKLOG.md](../BACKLOG.md).
  Done-when: a human films a room on a phone, uploads it at `?app=spaces`, and walks the
  resulting 3D scene in the cockpit — locally, `MOCK_OIDC=true`, no external paid service.
- **A GPU-free direct import lane is built** (`POST /scans/import`): pre-solved geometry from
  iPhone/iPad LiDAR, depth sensors, or drone photogrammetry (`.ply`/`.splat`) lands straight in the
  viewer — metric by construction, no reconstruction job. The honest fast path for users who already
  have a scanner; the sim/edge train remains for plain video.
- **Phase 2 — Guided Capture is done; GoPro ingest is the remaining done-when.** Done: a human opens
  the phone-HUD capture surface, follows the deterministic plan for a room / object / facade, and the
  WALK-vs-PAN arrows steer the walk while owner-scoped telemetry records it. Still done-when: a GoPro
  capture triggered from Camera Ops lands as real files in the owner-scoped media store, selectable as
  a scan source — benefit accrues to Camera Ops even if mapping never advances.
- **Phase 3 — the sim half is done.** A sim drone flies a mapper-drafted scan mission on the
  virtual-clock `SimDroneProvider` and the flight is recorded as a `'sim-mission'` scan source —
  autonomy proven before hardware, per ADR-099. Still done-when: real-drone MAVLink media ingest and
  the drone mission-overlay handoff into the ADR-098 doctrine; those stay gated and are not promised
  here.
- **Costs are compute-time, not vendor fees:** COLMAP/training minutes on owned hardware; no new
  API keys; no per-scan cloud spend. The GPU box becomes a shared resource between video
  generation and reconstruction — contention is accepted at this scale and revisited if it hurts.
- **The RF overlay shipped once poses existed.** With poses persisted (increment A), RSSI
  multilateration + coverage heat is built (increment B); it stays honestly room-level and remains
  an overlay, never a geometry source.
- **Phase 1 plus first increments of Phases 2–3 are built; the bytes-from-real-hardware gaps are
  not.** As each increment shipped, its collateral (this ADR's status line) was reconciled in the
  same effort, and every one carries its guards per the guard-per-fix directive: the splat-contract
  spec (`tests/unit/spatial-mapping-provider.spec.ts`), the owner-scoping spec
  (`tests/unit/spatial-mapping-store.spec.ts`), pose persistence
  (`tests/unit/spatial-poses.spec.ts`, increment A), the RF overlay
  (`tests/unit/spatial-rf.spec.ts`, increment B), the direct import lane
  (`tests/unit/spatial-import.spec.ts`), guided capture + telemetry + the sim drone flight
  (`tests/unit/spatial-capture-plan.spec.ts`), and the mapping conventions
  (`tests/unit/spatial-mapping-conventions.spec.ts`) — with the `/api/spaces` mount kept on the
  route-auth inventory guard. What the pipeline does NOT do: reconstruct the actual uploaded video
  locally — the Sim engine produces a real, walkable *synthetic* room so the pipeline + viewer are
  exercisable with no GPU; pointing `RECON_URL` at a reconstruction box runs the real video→splat
  train (the honest sim/edge split, mirroring SimDroneProvider/MavlinkDroneProvider). Still roadmap:
  GoPro media ingest, real-drone MAVLink media ingest, and the drone mission-overlay handoff.
