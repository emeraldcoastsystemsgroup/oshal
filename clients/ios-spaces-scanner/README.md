# OSHAL Spaces — iOS LiDAR Scanner (native ARKit client)

A small native iOS app that captures a **3D mesh of a room** with the iPhone's
**LiDAR** scanner (ARKit scene reconstruction), exports it to a portable `.ply`,
and imports it into the OSHAL **Spaces** swarm (`?app=spaces`). It is the "Import"
lane of [ADR-111](../../docs/adr/111-spatial-mapping-3d-reconstruction.md) made
first-class on the device that actually has the depth sensor.

> **Status:** buildable scaffold. It is written to compile and run on a real
> iPhone 15 Pro Max, but it has **not** been compiled here (this repo lives on
> Windows with no Xcode). You build, sign, and deploy it on a Mac — see
> [Build & deploy](#build--deploy-on-a-mac-step-by-step).

---

## Why native (and not a web page / PWA)

The whole reason this app exists: **LiDAR depth is native-only.** Safari / PWAs on
iOS have **no** API for the LiDAR sensor or ARKit's reconstructed scene mesh —
`getUserMedia` gives you an RGB camera frame and nothing more. There is no
`navigator.lidar`, no depth buffer, no `ARMeshAnchor` on the web. To read metric
depth and turn it into geometry you must go through **ARKit**, which is a native
framework. So OSHAL's browser capture pages (`spaces-capture.html`) can guide a
**video** walkthrough, but only a native app can hand the swarm a **real, metric
mesh** straight off the sensor with zero reconstruction cost.

Two more native-only wins this app leans on:

- **ARKit poses are already metric and gravity-aligned.** No fiducial, no COLMAP
  scale solve — the mesh is in meters with +Y up out of the box. The pose sidecar
  ships `metric: true, scaleSource: "arkit"` (contrast the video→COLMAP path, which
  is scale-free until anchored).
- **The reconstruction already happened on-device.** LiDAR + ARKit produce the mesh
  live, so the swarm's Import lane converts it to a viewer `.splat` with **no GPU
  box** (`RECON_URL` not required).

---

## What it does

1. **Pair** — paste your OSHAL host URL + a device-pairing token, or scan a QR that
   encodes them. Both are stored in the **Keychain** (the token is never shown back
   or logged).
2. **Scan** — runs `ARWorldTrackingConfiguration` with `sceneReconstruction =
   .meshWithClassification` (falls back to `.mesh`), shows the reconstructed mesh
   live (RealityKit `.showSceneUnderstanding` overlay) with a live anchor / vertex /
   pose counter. On a **non-LiDAR** device it shows a clear "LiDAR required" message
   instead of the camera.
3. **Export** — on stop, it parses **every** `ARMeshAnchor`'s real geometry (vertex
   buffer, normal buffer, triangle index buffer — honoring `offset`/`stride`/
   `bytesPerIndex`), transforms vertices into the ARKit world frame, merges all
   anchors, and writes a valid **ASCII `.ply`** plus a **`poses.json`** sidecar.
4. **Upload** — POSTs the scan to the swarm and surfaces the returned `scanId` /
   status (or a readable error).

Open `?app=spaces` in the OSHAL cockpit afterward to watch it convert and to walk it
in the WebGL viewer.

---

## Ingest contract (what this client sends)

```
POST  https://<oshal-host>/api/spaces/scans/import
Authorization: Bearer <device-pairing-token>          # oshal_pat_… (primary auth)
Content-Type:  multipart/form-data; boundary=…
```

Multipart parts:

| Part | Kind | Content-Type | Notes |
|---|---|---|---|
| `model` | file | `application/octet-stream` | the `.ply` (filename `scan.ply`) |
| `metadata` | text | `application/json` | the JSON below |
| `title` | text | — | mirrors `metadata.name` (back-compat) |

`metadata` JSON:

```jsonc
{
  "name": "Living room",
  "sourceKind": "lidar-ios",
  "capturedAt": "2026-07-20T18:22:41Z",   // ISO8601
  "deviceModel": "iPhone16,2",             // hw identifier (iPhone 15 Pro Max)
  "client": "oshal-ios-spaces-scanner/0.1",
  "mesh": { "anchorCount": 42, "vertexCount": 128034, "faceCount": 241902 },
  "poses": { "scanId": "…", "frame": { … }, "keyframes": [ … ] }  // optional; see below
}
```

Expected response (either shape is accepted by the client):

```jsonc
{ "scanId": "…", "status": "queued" }          // task contract
{ "scan": { "id": "…", "status": "queued" } }  // existing route shape
```

Non-2xx responses are surfaced verbatim (a JSON `{ "error": "…" }` message is
unwrapped; otherwise the raw body, truncated).

### The pose sidecar (`poses.json` / `metadata.poses`)

Per-keyframe camera pose + intrinsics, sampled from the ARKit frame stream, in the
**exact** `ScanPoses` shape the swarm uses
([`pose-types.ts`](../../src/features/spatial-mapping/model/pose-types.ts),
matching [`scripts/spatial-recon-edge/poses.py`](../../scripts/spatial-recon-edge/poses.py)
byte-for-byte):

- `center` = camera-to-world translation (the camera position in world space).
- `quat` = orientation as **`(w, x, y, z)`** (same order as `poses.py`).
- `frame` = `{ convention: "opengl", metric: true, scaleSource: "arkit", scale: 1.0,
  gravityAligned: true, upAxis: "y" }` — ARKit's camera convention is the OpenGL /
  Blender convention (+X right, +Y up, +Z toward the viewer).

It is written to disk **and** embedded under `metadata.poses` so the swarm can
reconcile a metric, gravity-aligned frame from the same request (increment A of the
pose-persistence design). A server that doesn't consume it simply ignores the key.

### ⚠️ Reconciliation with the server subagent

The swarm-side ingest endpoint is being built concurrently. The two places to
reconcile if its final contract differs — both are single constants at the top of
[`ScanUploadClient.swift`](Sources/Networking/ScanUploadClient.swift):

- **Auth header.** `Authorization: Bearer <token>` is the assumed default and is
  what the shipped PAT middleware
  ([`cli-token-routes.ts`](../../src/app/routes/cli-token-routes.ts)) already accepts
  on every `requiresAuth` route, including `/api/spaces/scans/import`. If the server
  chooses a different header (e.g. `X-Pairing-Token`), change the `setValue(…,
  forHTTPHeaderField:)` call.
- **File field name.** Defaults to `model` (the existing `multer.single('model')`
  route). Change `kFileFieldName` if the new endpoint expects `file`.

---

## Build & deploy on a Mac (step by step)

You need a **Mac** with **Xcode** and an **Apple ID** (a free one works for
on-device testing; a paid Developer account only if you want it to run past 7 days
or ship to TestFlight). No prior iOS experience assumed.

### 0. Why `project.yml` and not a checked-in Xcode project

There is **no `.xcodeproj` in this repo on purpose.** An Xcode project file is a
huge, UUID-keyed, order-sensitive plist that is extremely error-prone to hand-write
and merges terribly. Instead, [`project.yml`](project.yml) is a short, readable spec
that **XcodeGen** turns into a correct `.xcodeproj` in one command. Regenerate it any
time; never edit the generated project by hand.

### 1. Install the tools

```bash
# Xcode: install from the Mac App Store (large download), then open it once to
# accept the license and let it install components.
xcode-select --install          # command-line tools, if not already present

# Homebrew (if you don't have it): https://brew.sh
brew install xcodegen
```

### 2. Generate the Xcode project

```bash
cd clients/ios-spaces-scanner
xcodegen generate
open SpacesScanner.xcodeproj
```

### 3. Set signing + a unique bundle id

In Xcode: select the **SpacesScanner** target → **Signing & Capabilities**.

- **Team:** pick your Apple ID team from the dropdown (add your Apple ID under
  Xcode → Settings → Accounts first). This is the single required change.
- **Bundle Identifier:** must be **globally unique**. Change
  `com.emeraldcoastsystemsgroup.oshal.spacesscanner` to something you own, e.g.
  `com.<your-name>.spacesscanner`. (You can also set `DEVELOPMENT_TEAM` /
  `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` and re-run `xcodegen generate`.)
- Leave **Automatically manage signing** checked.

### 4. Connect your iPhone and run

1. Plug the **iPhone 15 Pro Max** into the Mac with a cable; tap **Trust** on the
   phone.
2. On the phone, enable **Developer Mode**: Settings → Privacy & Security →
   Developer Mode → On, then reboot when prompted (iOS 16+).
3. In Xcode's toolbar, pick your iPhone as the run destination.
4. Press **Run** (▶). The first build installs the app.
5. First launch of a free-account build: the cert is untrusted. On the phone go to
   **Settings → General → VPN & Device Management → <your Apple ID> → Trust**, then
   reopen the app.
6. Grant the **camera** permission when prompted (ARKit + the LiDAR sensor use it).

> Simulator note: the Simulator has **no LiDAR**, so the Scan tab will show the
> "LiDAR required" message there. Test capture on a real Pro device.

### 5. Get a pairing token from the OSHAL cockpit

The app authenticates with a **device-pairing token** — a short-lived OSHAL personal
access token (`oshal_pat_…`) minted under your user, sent as `Authorization: Bearer`.

- Sign in to the cockpit at your OSHAL host, open **`?app=spaces`**, and use its
  **Pair a device / phone pairing** action to mint a token (the swarm subagent wires
  the `POST /api/spaces/pair` mint + presents it, typically as a **QR** you scan on
  the Pair tab and/or a copyable string). The token is shown **once** — copy it then.
- Then in the app's **Pair** tab: enter your host URL (e.g.
  `https://oshal.example.com`) and paste the token, or tap **Scan pairing QR**.

Tokens are hashed at rest, owner-scoped, and can be **short-lived** (they expire) —
re-pair if uploads start returning 401.

---

## File tree

```
clients/ios-spaces-scanner/
├── README.md                         # this file
├── project.yml                       # XcodeGen spec (app target, iOS 17, sources, Info.plist)
├── Info.plist                        # NSCameraUsageDescription + arkit required capability
└── Sources/
    ├── SpacesScannerApp.swift        # @main SwiftUI App; owns PairingStore
    ├── RootView.swift                # Pair / Scan / Upload TabView
    ├── Models/
    │   ├── ScannerModel.swift        # shared state; hands the capture from Scan → Upload
    │   ├── PairingStore.swift        # observable pairing state over the Keychain
    │   └── DeviceInfo.swift          # hardware model identifier (deviceModel)
    ├── Security/
    │   └── KeychainTokenStore.swift  # Keychain get/set/delete for host + token
    ├── Capture/
    │   └── ARCaptureController.swift  # ARSession + RealityKit mesh overlay + pose sampling + export
    ├── Export/
    │   ├── PLYExporter.swift         # REAL ARMeshGeometry buffer parsing → merged ASCII .ply
    │   └── PoseSidecarWriter.swift   # poses.json (ScanPoses shape, wxyz quat)
    ├── Networking/
    │   └── ScanUploadClient.swift    # multipart URLSession client (streams body from a temp file)
    └── Views/
        ├── ARViewContainer.swift     # UIViewRepresentable around RealityKit ARView
        ├── QRScannerView.swift       # AVFoundation QR pairing scanner
        ├── PairView.swift            # host + token entry / QR
        ├── ScanView.swift            # AR session, start/stop, live counters, LiDAR guard
        └── UploadView.swift          # export review, upload progress, result scanId
```

---

## Assumptions you must fill in

| Thing | Where | Default (change it) |
|---|---|---|
| **OSHAL host URL** | Pair tab (or QR) at runtime | none — you enter it |
| **Device-pairing token** | Pair tab (or QR) at runtime | none — mint it in the cockpit |
| **Apple signing Team** | Xcode → Signing & Capabilities, or `DEVELOPMENT_TEAM` in `project.yml` | empty (`""`) |
| **Bundle identifier** | Xcode, or `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` | `com.emeraldcoastsystemsgroup.oshal.spacesscanner` |
| **Auth header** (if server differs) | `ScanUploadClient.swift` `setValue(…, forHTTPHeaderField: "Authorization")` | `Authorization: Bearer` |
| **File field name** (if server differs) | `ScanUploadClient.swift` `kFileFieldName` | `model` |

---

## Design notes / honest limits

- **ASCII PLY** is emitted (not binary) so the file is trivial to eyeball and diff;
  the OSHAL import lane accepts ASCII or binary `.ply` equally. Binary export is a
  documented follow-up, not a silent gap.
- The PLY carries **vertex positions + normals + triangle faces**. ARKit mesh
  geometry has **no per-vertex color**, so no color is written (the import lane
  renders mesh vertices as a point cloud today; faces aren't sampled yet — see the
  playbook). Face **classification** is available from ARKit and is a natural next
  addition if the swarm wants per-face semantics.
- Poses are sampled at ~2.5 Hz and capped (600 keyframes) to keep the sidecar small.
- Deployment target is **iOS 17**. Requires a **LiDAR** device
  (iPhone 12 Pro+/iPad Pro 2020+); guarded at runtime via
  `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)`.
- No third-party dependencies — pure ARKit / RealityKit / AVFoundation / SwiftUI /
  Foundation / Security, so it builds clean with only Xcode.
```
