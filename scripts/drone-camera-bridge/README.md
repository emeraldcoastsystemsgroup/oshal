# Camera → OSHAL bridge

Bring a **real camera** into the Drone Ops app's **Live camera** card, using the
same `DRONE_VIDEO_URL` mechanism the drone-node runtime already has — no raw
browser→device link, no new surface.

The chain: `camera source → OpenCV → MJPEG stream → a drone node that declares the
stream as DRONE_VIDEO_URL → OSHAL fleet heartbeat → the Live camera card`.
Live-proven with the host webcam on 2026-07-18.

## Quick start (host webcam)

```bash
bash scripts/drone-camera-bridge/camera-bridge.sh
```

Then in `?app=drone`: hard-refresh, pick **camera-1** in the Fleet panel — the
Live camera card shows the real feed. Ctrl-C tears both processes down.

## Any camera source

`--source` takes a **local camera index** OR a **capture URL** OpenCV can open:

```bash
# default webcam (index 0)
bash scripts/drone-camera-bridge/camera-bridge.sh --source 0 --id camera-1 --label "Desk cam"

# a second/USB camera (e.g. a GoPro in USB "webcam mode" — find its index first)
bash scripts/drone-camera-bridge/camera-bridge.sh --source 1 --id camera-hero --label "GoPro Hero" --stream-port 8091 --node-port 4105

# an existing network stream (IP camera, or a GoPro Wi-Fi UDP preview)
bash scripts/drone-camera-bridge/camera-bridge.sh --source "rtsp://user:pass@192.168.1.50:554/stream" --id ipcam-1
```

Find local camera indices:

```bash
python - <<'PY'
import cv2
for i in range(5):
    c = cv2.VideoCapture(i, cv2.CAP_DSHOW)
    ok = c.isOpened() and c.read()[0]
    print(i, "usable" if ok else "-")
    c.release()
PY
```

## GoPro Hero

- **USB webcam mode (Hero 8 Black+):** install the GoPro Webcam desktop utility,
  plug in, enable webcam mode → it appears as a new camera index → run the bridge
  with that `--source <index>`. Cleanest path; the camera charges while streaming.
- **Wi-Fi:** join the GoPro's `GPXXXXXXXX` network, start its live preview
  (model-specific API at `10.5.5.9`), and point `--source` at the resulting UDP/HTTP
  stream. Note this drops the host off its home Wi-Fi unless the camera can join the
  router instead. (Legacy `gpControl` API on Hero 4–7; "Open GoPro" on Hero 9+.)

## Requirements

- `python` with `opencv-python` and `flask`.
- `SWARM_SERVICE_SECRET` in the repo-root `.env` (the node fails closed without it).
- The OSHAL stack running (`?app=drone` reachable).

## Notes

- The feed carries a timestamp/label overlay so it's obviously the real camera, not
  the synthetic **CAM** first-person view.
- These are **on-demand** processes — continuous capture uses CPU, so start the bridge
  when you want the feed and Ctrl-C it when you're done (don't leave it grinding).
- Multiple cameras: run several bridges with distinct `--id`, `--stream-port`, and
  `--node-port`; each appears as its own drone in the fleet.
