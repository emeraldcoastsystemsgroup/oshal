# Camera node — connecting a GoPro to Camera Ops (`?app=camera`)

Camera Ops controls a real camera through a **camera-node**: a small companion process
(`npm run camera:node`, [src/app/camera-node-server.ts](../../src/app/camera-node-server.ts)) that
runs **on a host that shares the camera's Wi-Fi/USB link** — a container can't reach a GoPro on its
own Wi-Fi. The node holds the device link, heartbeats telemetry/events/captures up to the controller
over the service-secret rail, and executes secret-guarded command envelopes. The controller and the
`?app=camera` surface never talk to the camera directly.

With **no camera at all**, the app still works: an embedded `sim-1` camera is always present, so the
surface, controls, captures gallery, and concierge are fully exercisable. Add real cameras by running
one camera-node per camera.

## Which link mode? (this decides everything)

| Camera | Link mode | Bluetooth needed? | Base address |
|---|---|---|---|
| **HERO9 / HERO10** | `usb` (recommended) or `ap` | USB: no · AP: yes (to enable Wi-Fi) | usb `http://172.2X.1YZ.51:8080` · ap `http://10.5.5.9:8080` |
| **HERO11 / HERO11 Mini** | `usb` or `ap` | same as above | same as above |
| **HERO12 / HERO13** | `cohn` (LAN-IP over HTTPS) or `usb`/`ap` | COHN: yes, once, to provision | cohn `https://<lan-ip>` |

- **USB is the easiest and the recommended test path for a HERO9** — no Bluetooth, no joining the
  camera's Wi-Fi, no losing your internet. Plug the camera in; it enumerates as a USB-ethernet device.
- **AP mode** makes the *host* join the camera's own Wi-Fi (`10.5.5.9`), which needs a one-time BLE
  command to turn the camera's Wi-Fi on and takes over that adapter's network.
- **COHN** (Camera On the Home Network) is the clean "control by LAN IP over HTTPS" path but is
  **HERO12+ only** and needs one-time BLE provisioning. See the BACKLOG follow-up — the node's HTTP
  control plane is real today; BLE provisioning is not yet automated.

## HERO9 over USB — the test recipe

1. **On the camera:** Preferences → Connections → set **USB Connection = MTP** (not "GoPro
   Connect"), then plug the HERO9 into the host with a data USB-C cable. The camera comes up as a
   USB-ethernet interface at `172.2X.1YZ.51`, where `XYZ` are the last three digits of the serial
   (e.g. serial ending `789` → `172.27.189.51`). You can also find the address via mDNS `_gopro-web`.
2. **Run the node** on the host that shares the swarm network (same box as the api is fine — reach it
   back via `host.docker.internal`):

   ```bash
   SWARM_SERVICE_SECRET=<the swarm service secret> \
   OSHAL_API_URL=http://localhost:35457 \
   CAMERA_NODE_ID=gopro-1 \
   CAMERA_NODE_ENDPOINT=http://host.docker.internal:4200 \
   CAMERA_PROVIDER=gopro \
   CAMERA_GOPRO_LINK=usb \
   CAMERA_GOPRO_SERIAL=<your camera serial> \
   npm run camera:node
   ```

   Instead of `CAMERA_GOPRO_SERIAL` you may pass the address directly:
   `CAMERA_GOPRO_BASE_URL=http://172.27.189.51:8080`.

3. **Open** `/cockpit?app=camera`. `gopro-1` appears in the fleet within a few seconds (heartbeats
   every 2s; goes **offline** after 15s of silence). Use Record/Stop, Photo, the mode control, and
   Preview. Captures land in the gallery; the concierge ("start recording", "switch to photo") drives
   the same commands. Delete-all requires an explicit confirm.

### Endpoint / env reference

- `CAMERA_NODE_ENDPOINT` must be an address the **controller** can dial back:
  - controller in Docker, node on the host → `http://host.docker.internal:4200`
  - both native on one host → `http://127.0.0.1:4200` (use the literal IP — on Windows `localhost`
    can resolve to `::1` and hang the controller's dial)
  - node on another box → `http://<its-LAN/tailnet-IP>:4200`
- `CAMERA_VIDEO_URL` (optional) — a **browser-playable** feed URL the node serves (e.g. a transcoded
  HLS/MJPEG stream). The GoPro's own preview is H.264/MPEG-TS over **UDP :8554**, which a browser
  can't play directly; until a transcode step exists (BACKLOG), leave this unset and the surface
  shows a "preview running at the node" note when preview is active.
- `CAMERA_GOPRO_LINK` = `usb` | `ap` | `cohn`. For `ap` the base defaults to `http://10.5.5.9:8080`
  (the host must already be joined to the camera's Wi-Fi). For `cohn`, set
  `CAMERA_GOPRO_BASE_URL=https://<lan-ip>` plus `CAMERA_GOPRO_USER` / `CAMERA_GOPRO_PASS`.

## Safety + behavior notes

- The node **fails closed**: no `SWARM_SERVICE_SECRET`, no node (an unauthenticated node would take
  commands from anyone who can reach its port).
- Commands are **serialized** against the camera's System-Busy / Encoding flags; a shutter-start while
  encoding (or a stop while idle) is rejected with a clear message, surfaced inline on the cockpit.
- A **keep-alive** goes out every heartbeat (~2s) — GoPro sleeps after ~5s idle — and doubles as the
  state refresh, so the fleet/telemetry stay current without extra polling.
- Reads (fleet/state/captures) are served from the last-heartbeat cache and never block on the camera.

## Other brands

The `CameraProvider` interface is engine-agnostic (GoPro is the first real adapter). Adding a brand is
one new adapter, not a new app: Canon CCAPI and ONVIF/RTSP cameras are the next-easiest (both are
LAN-IP HTTP); Sony CRSDK, Insta360, and DJI Osmo are gated/proprietary. Tracked in the BACKLOG.
