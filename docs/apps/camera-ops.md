# Camera Ops

Camera Ops (`?app=camera`) controls owned camera devices from OSHAL.

## What Is Built

- **Embedded simulator:** `sim-1` is always present, so the fleet, command buttons, events, and captures can be exercised without hardware.
- **Browser / USB camera preview:** the surface has a `Connect browser camera` button that uses `getUserMedia` for a local preview. This is a browser-only preview path; OSHAL does not claim controller-side recording from that local stream.
- **GoPro camera-node path:** real GoPro USB, AP Wi-Fi, and COHN links join through `npm run camera:node`. The node heartbeats into `/api/camera/nodes/heartbeat`, declares optional `CAMERA_VIDEO_URL`, and receives commands through the service-secret rail.
- **Clear unsupported-provider fallback:** ONVIF, RTSP, Nest, Ring, and other cloud/network cameras are shown as adapter-required. They can be bridged by a camera-node that exposes a browser-playable `videoUrl`, or by adding a real provider adapter.

## How To Connect A Real GoPro

Follow [the GoPro camera-node runbook](../runbooks/camera-node-gopro.md). The recommended first test path is HERO9/HERO10/HERO11 over USB:

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

Open `/cockpit/?app=camera`; the node should appear in the fleet within a few seconds.

## Known Bounds

- Browser preview requires HTTPS or localhost and explicit browser permission.
- GoPro preview needs a browser-playable `CAMERA_VIDEO_URL`; the native GoPro UDP preview is not directly playable by browsers.
- Cloud-camera vendor adapters are not built yet; the UI says this explicitly instead of hiding the path behind the simulator.
