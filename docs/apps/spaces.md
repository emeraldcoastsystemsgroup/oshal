# Spaces — operator guide (`?app=spaces`, ADR-111)

**Status: BUILT + active.** Spaces is an installed OSHAL application — a package from the
[oshal-applications store](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/spaces),
not standalone code wired into the controller. It is defined by the package manifest
(`suite: ai-home`), reasoned over by the `spaces-operator` concierge
([`ai-lab/bot-personas/spaces-operator.yaml`](../../ai-lab/bot-personas/spaces-operator.yaml),
registered in both bot registries, agentId `b0300000-…-0001`, inline on `oshal-api`), and served by
the installed package route over the owner-scoped scan store in
[`src/features/spatial-mapping/`](../../src/features/spatial-mapping/). It was built in-repo first
per ADR-099 sequencing and then carved to the store per ADR-085. The engine + scan store stay core
(ADR-093).

## What it does

Turn a real space into an explorable 3D scene and reason over it. Open `?app=spaces` and you get a
scan list, job progress, and a self-contained WebGL viewer (drag to orbit, scroll to zoom, WASD to
fly). Everything below is **as-built with unit guards** on `main` (2026-07-20).

### Getting a scene in — the capture paths

| Path | Route | Input | GPU box? | Best for |
|---|---|---|---|---|
| **Reconstruct** | `POST /api/spaces/scans` (`video`) | a walkthrough video | Yes (`RECON_URL`) | phones/drones with only video; highest fidelity |
| **Import** | `POST /api/spaces/scans/import` (`model`) | a finished `.ply`/`.splat` | **No** | iPhone/iPad Pro LiDAR, depth sensors, drone photogrammetry apps — metric by construction |
| **Sim drone scan** | `POST /api/spaces/drone-scan` | (none) | No | a working demo of drone-as-capture: a sim drone flies an overlap orbit and the captures flow the pipeline |

The **reconstruct** lane runs through a provider seam: the always-available `SimReconstructionProvider`
(a real, renderable synthetic room — no GPU, works with `MOCK_OIDC`) or the real
`EdgeReconstructionProvider` against a self-hosted GPU box over `RECON_URL`
([`scripts/spatial-recon-edge/`](../../scripts/spatial-recon-edge/README.md):
ffmpeg→COLMAP→splatfacto→`.splat`, optional `RECON_TOKEN` shared secret, job-dir reaping).

### Mobile ingest — phone pairing (no browser login on the phone)

The **import** lane is how an iPhone/iPad Pro LiDAR scan gets back to the swarm — but a phone (native
app or an iOS Shortcut) can't carry a browser OIDC session. Pairing solves that with a **short-lived,
revocable, owner-scoped bearer token**, reusing the existing PAT store (`oshal_cli_tokens`) — no new
credential system. There are **no anonymous writes**: the phone always carries a token that resolves
to a real owner sub.

**Flow**

1. **Mint (from a signed-in session):** the logged-in owner calls the auth-gated
   `POST /api/spaces/pair`. It mints a token **for their own sub only** (never a body-supplied sub)
   and returns the token, its expiry, and a QR-friendly `qr` payload for the native app to scan.
   Optional body: `{ "device": "iPhone 15 Pro", "ttlMinutes": 1440 }` — TTL defaults to 24h and is
   clamped to 5 min … 30 days.
2. **Upload (from the phone, no browser):** the phone POSTs the capture to the ingest route with
   `Authorization: Bearer oshal_pat_…`. The global CLI-token middleware resolves the (unexpired,
   unrevoked) token to the owner, so the scan lands under that owner — same code path as a
   browser upload.
3. **Revoke:** phone tokens live in the same list as CLI tokens — `GET /api/cli-tokens` to see them,
   `DELETE /api/cli-tokens/:id` to revoke. An expired or revoked token authenticates on no route.

```bash
# 1) Mint a pairing token (run where you're signed in — a cookie session or an existing PAT works).
curl -X POST https://oshal.example.com/api/spaces/pair \
  -H "Authorization: Bearer oshal_pat_<an existing PAT>" \
  -H "Content-Type: application/json" \
  -d '{"device":"iPhone 15 Pro","ttlMinutes":1440}'
# -> { "pairing": { "token": "oshal_pat_…", "expiresAt": "…", … },
#      "ingest": { "importUrl": "https://…/api/spaces/scans/import", "fields": { "import": "model" }, … },
#      "qr": "{\"v\":1,\"kind\":\"oshal-spaces-pairing\",\"api\":\"https://…/api/spaces\",\"token\":\"oshal_pat_…\"}" }

# 2) On the phone (native app or iOS Shortcut): upload the LiDAR export with the paired token — no browser.
curl -X POST https://oshal.example.com/api/spaces/scans/import \
  -H "Authorization: Bearer oshal_pat_…" \
  -F "model=@garage.ply" \
  -F "title=Garage"
# A walkthrough video uses the same header against POST /api/spaces/scans with field "video".
```

Guarded by [`tests/unit/spaces-phone-pairing.spec.ts`](../../tests/unit/spaces-phone-pairing.spec.ts):
the tokened ingest **accepts** a valid pairing token (under the owner sub) and **rejects** a missing,
foreign, unknown, expired, or revoked one.

### Guided capture — "tell me where to go"

- **Deterministic capture plan:** `GET /api/spaces/capture-plan?target=room|large-room|object|facade`
  returns a step-by-step filming plan (prep → scale marker → orbits → loop closure), shown as a
  step-through panel on the surface.
- **Live phone HUD:** `GET /api/spaces/capture` serves a rear-camera page with two distinct arrow
  channels — **WALK** chevrons (which way to move, from the phone's motion sensor) and a **PAN** ring
  (which way to point, from the compass) — plus a too-fast-pan blur warning. Phone telemetry
  (heading / sweep / steps / GPS) posts to `POST /api/spaces/capture-telemetry` (owner-scoped JSONL).
  The guidance contract is deliberately actuator-agnostic: a human with a phone is the first
  capture actuator; a drone is the same loop later.

### Reasoning over a finished scene

- **Camera-pose persistence:** the poses COLMAP solves are kept as a `poses.json` sidecar
  (frame-reconciled with the training dataparser transform); `GET /api/spaces/scans/:id/poses`.
- **Wi-Fi / RF coverage overlay:** `POST /api/spaces/scans/:id/rf` fits a router by
  Levenberg-Marquardt multilateration over pose-keyed RSSI (≥4 samples per transmitter) and paints a
  red→green coverage heat onto the splat. Honest rails baked in: **room-level, not centimetre**, and
  **an overlay on the camera-built geometry, never geometry itself.**

## How to run it

Spaces is activated by installing/staging the `spaces` app package. The package manifest and surface
are live from the installed app volume; the spatial-mapping engine is baked into the core image. After
installing or updating the package, rebuild/recreate the OSHAL stack only when the core engine changes:

```bash
bash scripts/oshal-deploy.sh
```

For **real** video reconstruction (instead of the Sim synthetic room), stand up the GPU-box service on
a CUDA box, set `RECON_URL` (and `RECON_TOKEN`) in `.env`, then deploy — see the
[recon-edge README](../../scripts/spatial-recon-edge/README.md). The **import lane** needs no GPU and
is the fastest real map if you have an iPhone/iPad Pro (scan with Scaniverse, export `.ply`, import).

## Honest roadmap (NOT built)

Real-drone media ingest (MAVLink follow-up) and the drone mission-overlay handoff; bot-personalized
(vs deterministic) capture plans; live turn-by-turn pose feedback (guidance ladder v3, plus v2 WebRTC
streaming); ArUco-fiducial metric anchoring; real RSSI walk-survey capture tooling; GoPro raw-media
ingest; drone relocalization against a prior map. See [ADR-111](../adr/111-spatial-mapping-3d-reconstruction.md),
the [pose-persistence spec](../architecture/spatial-mapping-pose-persistence.md), the
[capture playbook](../architecture/spatial-capture-playbook.md), and [BACKLOG.md](../BACKLOG.md).
