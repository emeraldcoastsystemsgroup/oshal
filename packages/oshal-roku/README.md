# OSHAL Home — Roku channel

A native **Roku SceneGraph** channel that turns a Roku into an **OSHAL Jarvis + Smart Home** surface.

Roku is **not** like Fire TV: it has **no WebView / no browser component**, so it cannot load the
web Jarvis/Home pages the way the [Fire TV](../oshal-firetv/) (Android WebView) and
[Samsung Tizen](../oshal-samsung-tv/) (web container) apps do. This channel is therefore a **real
native client** that reads the OSHAL JSON APIs in BrightScript. It is still a **surface** in the
ADR-047 sense — it holds only the host URL + a paired token; all reasoning and aggregation live on
the OSHAL host and cloud swarm.

Two screens:

- **Jarvis (default):** a **scan-to-talk QR** for the phone push-to-talk remote
  (`/api/jarvis/remote`) plus the **live conversation** polled from `/api/jarvis/history`. You talk
  from your phone; Jarvis's answers appear on the TV. This is the same phone-as-mic / TV-as-display
  experience as the Fire TV Jarvis view, rebuilt natively. This screen claims a **room** (default
  `Roku TV`; override via the registry `room` key) so the phone can target it specifically — scanning
  *this* TV's QR pre-selects its room, and only the targeted screen shows the reply (no multi-TV echo).
- **Smart Home (press `*`):** the device grid + scene list from `/api/home/devices` + `/scenes`,
  with instant actions (`/control`, `/scene/run`).

## How auth works (device-link pairing — scan to sign in)

Because Roku can't run the OIDC login redirect, it pairs the way Netflix/YouTube do on a TV:

1. On first run the channel calls `POST /api/tv/pair/start` and shows a **scannable QR code** (plus
   a typed `user_code` fallback).
2. **Scan the QR** with your phone (or open the shown URL) → sign in to OSHAL (Google) → the code is
   pre-filled → approve. The QR encodes `…/tv?code=<user_code>`, rendered as a PNG by
   `GET /api/tv/pair/qr` (Roku's `Poster` can't draw an SVG, so the server returns a PNG).
3. The channel polls `POST /api/tv/pair/poll`; on approval it receives a **signed TV token**
   (bound to your account) and stores it in the Roku registry.
4. From then on every API call carries that token (`X-OSHAL-TV-Token`). On a `401`
   (token expired/revoked) the channel automatically clears it and re-pairs.

Server side this is the **shared** TV pairing rail
[`src/app/routes/tv-pairing-routes.ts`](../../src/app/routes/tv-pairing-routes.ts) (the same one the
Fire TV app uses). Its `createTvTokenAuthMiddleware` injects an authenticated `req.oidc` from the
token, so every `requiresAuth` route — including `/api/home` — resolves the paired user with no
per-route change. The Fire TV WebView presents the token as the `oshal_tv` **cookie**; the native
Roku channel presents the same token via the **`X-OSHAL-TV-Token` header** (added to the middleware
for this). Tokens are HMAC-signed `v1.<payload>.<sig>` (secret: `SESSION_SECRET`, falling back to
`AUTH_SESSION_SECRET`/`KEYCLOAK_CLIENT_SECRET`); pairing fields are `user_code` / `device_code` /
`verification_uri`. The approval page is `GET /tv` (requiresAuth → normal Google login).

## Layout (files)

| File | Role |
|---|---|
| `manifest` | Channel metadata + asset paths (data file). |
| `source/main.brs` | Entry point — creates the screen, runs `HomeScene`. |
| `components/HomeScene.{xml,brs}` | The scene: pairing (login QR) → Jarvis (default) / Smart Home (`*`). |
| `components/DeviceCard.{xml,brs}` | One device tile (name + on/off pill + focus ring). |
| `components/HttpTask.{xml,brs}` | One-shot HTTPS on a Task thread (Roku bans net on render thread). |
| `images/*.png` | **Placeholder** icon/splash at Roku's required sizes — replace before publishing. |

## Remote mapping

- **`*` (Options)** toggles between **Jarvis** and **Smart Home**.
- On **Smart Home:** D-pad moves focus, **LEFT/RIGHT** jumps between the Scenes list and the Devices
  grid, **OK** toggles the focused device / runs the focused scene.
- **BACK** exits the channel.

## Configure the host

Defaults to the production tunnel `https://oshal.agenticfederal.us`. To point at a LAN/dev host,
write a `host` key into the channel's registry section from a Roku BrightScript console, or add a
host-entry screen (backlog). Example via the dev console (telnet port 8085 after sideload):
`CreateObject("roRegistrySection","oshal").Write("host","http://192.168.1.20:5000")`.

> Roku requires **HTTPS with a valid CA-signed cert** for `roUrlTransfer` by default. A plain-LAN
> `http://` host works from the dev console but public TLS (the Cloudflare tunnel) is the supported
> path; self-signed LAN certs will fail TLS validation.

## Build / sideload (developer mode)

> Like the Fire TV APK, this channel was **authored** in this repo but **not built/tested** on a
> Roku here. Sideload it from any machine with the Roku device on the same network.

1. **Enable developer mode on the Roku:** on the remote press
   `Home ×3, Up ×2, Right, Left, Right, Left, Right`. Set a dev password and note the device IP.
2. **Replace the placeholder images** in `images/` with real PNGs at the exact sizes (see
   [`images/README.md`](images/README.md)) — sideload tolerates the placeholders; publishing does not.
3. **Zip the channel** (zip the *contents*, not the parent folder — `manifest` must be at the zip root):
   ```bash
   cd packages/oshal-roku
   zip -r ../oshal-roku.zip manifest source components images
   ```
4. **Upload** at `http://<roku-ip>` → the Development Application Installer → pick `oshal-roku.zip`
   → **Install**. The channel launches; complete pairing on your phone.
5. **Debug console:** `telnet <roku-ip> 8085` streams BrightScript logs.

## Publishing

See the registration + publishing runbook:
[`docs/tv-surfaces/roku-and-samsung-registration.md`](../../docs/tv-surfaces/roku-and-samsung-registration.md).

## Scope / non-goals

- Surface only — no inference, no tokens beyond the paired TV token, no device aggregation.
- Jarvis on Roku **displays** the conversation; it does **not speak** the answer (Roku has no public
  channel TTS API — the Fire TV/Samsung web views speak via the browser/native TTS bridge). Roku
  spoken output is backlog.
- The phone push-to-talk remote (`/api/jarvis/remote`) is shared with Fire TV/Samsung — Roku just
  shows its scan-to-talk QR. Schedules UI and a host-entry screen are backlog (the web surfaces have them).
