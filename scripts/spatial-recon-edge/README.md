# spatial-recon-edge — the GPU-box reconstruction service (ADR-111)

This is the **box-side half** of OSHAL Spaces. The in-repo TypeScript
`EdgeReconstructionProvider` is only a *client + wire protocol*; this service is what
actually turns an uploaded walkthrough **video → a real 3D Gaussian-Splat scene**.

Point `RECON_URL` at it and `?app=spaces` reconstructs the **real** video (instead of the
local Sim synthetic room).

```
OSHAL api  ──POST /reconstruct (video bytes)──▶  spatial-recon-edge (GPU box)
           ◀──── {jobId} ────                       │ ffmpeg → COLMAP → splatfacto → .ply → .splat
           ──GET /jobs/:id (poll)──▶                 │ (tens of min … ~1.5h on an RTX 4060)
           ──GET /jobs/:id/splat──▶  .splat  ◀───────┘
```

## Protocol (exactly what the provider drives)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `200 {ok:true}` |
| `POST` | `/reconstruct` | body = raw video bytes (`application/octet-stream`); headers `X-Scan-Id`, `X-Source-Name`, `X-Source-Kind` → `{jobId}` |
| `GET` | `/jobs/:id` | `{status: queued\|running\|done\|error, error?, gaussianCount?}` |
| `GET` | `/jobs/:id/splat` | the packed `.splat` bytes (`done` jobs only) |
| `GET` | `/jobs/:id/poses` | per-keyframe camera poses (`poses.json`, ADR-111 increment A) when solved — **re-expressed in the training frame** (dataparser transform + scale applied) so they line up with the exported splat |

When `RECON_TOKEN` is set, **every** request must carry a matching `X-Recon-Token` header
(the OSHAL `EdgeReconstructionProvider` sends it automatically when its own `RECON_TOKEN`
env is set). Unset = open — rely on network isolation only if you accept that anyone who
can reach the box can submit jobs and fetch scans.

## Deploy — bare metal (recommended: reuse the ComfyUI box)

The server is **stdlib-only**, so if your GPU box already runs ComfyUI it already has
CUDA + Python — you only need the CV toolchain on `PATH`:

1. Install **ffmpeg**, **COLMAP**, and **nerfstudio** (which provides `ns-process-data` /
   `ns-train` / `ns-export`) per <https://docs.nerf.studio/quickstart/installation.html>
   (install a CUDA-matched torch **first**).
2. Run it:
   ```bash
   cd scripts/spatial-recon-edge
   RECON_PORT=8008 RECON_WORK_DIR=/data/recon-jobs python server.py
   ```
3. Confirm: `curl http://localhost:8008/health` → `{"ok": true, ...}`.

## Deploy — Docker

```bash
cd scripts/spatial-recon-edge
docker build -t oshal-recon-edge .
docker run --gpus all -p 8008:8008 -v /data/recon-jobs:/data/recon-jobs oshal-recon-edge
```

## Wire it into OSHAL

The api container reads `RECON_URL`. Over **Tailscale** (same pattern as the ComfyUI edge
node), point it at the box's tailnet address:

```bash
# .env  (compose already passes RECON_URL through to the api service)
RECON_URL=http://<gpu-box-tailscale-host>:8008
```

Then `bash scripts/oshal-deploy.sh` (or restart the api). With `RECON_URL` reachable, the
`SpatialMappingService` picks the **Edge** provider automatically; unset/unreachable, it
falls back to Sim — so this is purely additive.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `RECON_PORT` / `RECON_HOST` | `8008` / `0.0.0.0` | listen address |
| `RECON_TOKEN` | unset (open) | shared secret — set the SAME value in the OSHAL api env; every request then requires `X-Recon-Token` |
| `RECON_WORK_DIR` | system temp `/oshal-recon` | per-job scratch (source + frames + splat) |
| `RECON_JOB_TTL_SECONDS` | `86400` (24h) | terminal jobs' work dirs are reaped after this — a real job leaves multiple GB of intermediates |
| `RECON_MAX_ITERS` | `7000` | splatfacto training iterations |
| `RECON_NUM_FRAMES` | `300` | frames `ns-process-data` targets |
| `RECON_STUB` | unset | **self-test only** — skip the CV toolchain, emit a small valid synthetic `.splat` so the protocol runs on a box with no GPU |

## Verify

```bash
python test_recon.py     # converter + FULL protocol + poses/dataparser + RECON_TOKEN gate + reaper, in stub mode
```

**Verification status (honest):** the HTTP protocol and the `.ply→.splat` converter are
verified here with Python 3.11 (no GPU needed) — `test_recon.py` is green. The
**COLMAP/nerfstudio CV pipeline itself runs on the GPU box** and is not exercised by the
test; the end-to-end close ("one real room video from `?app=spaces` reconstructs through
`RECON_URL`") is the deploy step on your hardware. Resource envelope: room-scale on an
8GB-VRAM card (RTX 4060 class); a house = multiple linked scans, per ADR-111.

## Files

`server.py` (stdlib HTTP) · `pipeline.py` (ffmpeg→COLMAP→splatfacto→export) ·
`ply_to_splat.py` (pure-Python converter, mirrors the TS import lane) ·
`poses.py` (transforms.json → training-frame poses.json, ADR-111 increment A) ·
`test_recon.py` (guard) · `Dockerfile` / `entrypoint.sh` / `requirements.txt`.
