# ADR-068 — TV surfaces across platforms (Roku, Samsung) + the device-link pairing rail

- **Status:** Accepted — BUILT (authored) 2026-06-22. Roku native SceneGraph channel + Samsung
  Tizen web app are in the tree; they reuse the existing Fire TV pairing rail (extended to accept
  the token via header). Roku/Samsung not yet compiled/sideloaded/published (no Roku/Tizen toolchain
  on the dev box). **Update 2026-06-23:** the **Fire TV APK is now compiled and sideloaded onto a
  live Firestick** (Android toolchain installed on the dev box under `C:\Android\Sdk` + OpenJDK 17) —
  device pairing + phone-as-mic Jarvis voice + neural TTS verified on-device.
- **Date:** 2026-06-22
- **Related:** [ADR-047 (smart-home edge agent — the Fire TV node is §5/phase-3)](047-smart-home-edge-agent.md),
  [ADR-036 (bot-owned application architecture — surface is a view over the bot's store)](036-bot-owned-application-architecture.md),
  [ADR-044 (device-as-swarm-node A2A rail)](044-mobile-companion-app.md);
  packages [`oshal-firetv`](../../packages/oshal-firetv/), [`oshal-roku`](../../packages/oshal-roku/),
  [`oshal-samsung-tv`](../../packages/oshal-samsung-tv/); the home surface and routes now live in
  the store-side Smart Home package after ADR-085.
- **Runbook:** [docs/tv-surfaces/roku-and-samsung-registration.md](../tv-surfaces/roku-and-samsung-registration.md).

## Context

ADR-047 shipped the **Fire TV** node: a thin Android WebView wrapping the OIDC-gated Smart Home
dashboard at `/api/home/ui`, plus D-pad focus injection. The operator wants the same surface on the
**other living-room platforms** — starting with **Roku** and **Samsung** — and, critically, a
**repeatable way to register/publish** each, not just sideload instructions.

The platforms are not the same kind of thing, and that drives the design:

- **Samsung (Tizen)** TV apps **are** web apps. Near-direct analog to Fire TV — but there is no
  native WebView wrapper to inject focus-nav into a remote page, and **Google's OIDC login refuses
  to render inside an iframe** (`X-Frame-Options`). So the app must navigate the **top window** to
  the dashboard.
- **Roku** runs **BrightScript + SceneGraph** with **no WebView / no browser component at all**. It
  cannot wrap `/api/home/ui`. It must be a **native client** over the JSON API — and because there
  is no browser, it cannot complete an OIDC redirect, so it needs a **browserless auth rail**.

The existing `/api/home/*` routes authenticate only via the OIDC **session** (`callerSub` reads
`req.oidc.user`). A browserless device has no session, and the prefix is blanket-`requiresAuth`, so
a Roku request is rejected before any handler runs.

## Decision

**1. One surface contract, two transports.**
- **Web-capable TV platforms** (Samsung now; LG webOS, Android-web, etc. later) load the dashboard
  **top-level** at `…/api/home/ui?tv=1`. The `?tv=1` flag activates a **self-contained D-pad
  spatial-navigation** script added to `home.html` — geometry-based nearest-focusable movement +
  OK-to-activate — so navigation does not depend on each platform's own (unreliable) spatial nav,
  and OIDC login works as a normal page. Fire TV is unchanged (it injects its own equivalent and
  loads *without* `?tv=1`, so the block stays dormant there).
- **No-browser platforms** (Roku; Apple-TV-native later) render natively from the JSON read-model
  (`/api/home/devices`, `/scenes`) and act via `/control` + `/scene/run`, sending an
  `X-OSHAL-TV-Token` bearer.

**2. Reuse the existing device-link pairing rail; extend it for native clients.**
The OAuth-device-grant rail already exists for Fire TV
([`src/app/routes/tv-pairing-routes.ts`](../../src/app/routes/tv-pairing-routes.ts)):
`POST /api/tv/pair/start` (public) → user approves on a phone at the OIDC-gated `/tv` page
(`POST /api/tv/pair/approve`) → `POST /api/tv/pair/poll` (public) returns an HMAC-signed token
(`v1.<payload>.<sig>`, secret `SESSION_SECRET`→fallbacks, 90-day TTL, not persisted).
`createTvTokenAuthMiddleware` injects an authenticated `req.oidc` from the token, so `/api/home`
(and every `requiresAuth` route) resolves the paired user with **no `callerSub` change**. Roku does
not have a browser cookie jar, so the **only** server change here is teaching that middleware to
read the token from the **`X-OSHAL-TV-Token` / `Authorization: Bearer` header** in addition to the
`oshal_tv` cookie. Fire TV (cookie) is byte-for-byte unchanged.

**2b. "Scan to sign in."** Pairing now also returns a `qr_url` and `GET /api/tv/pair/qr` renders a
QR **PNG** (Roku's `Poster` can't draw an SVG) encoding the prefilled `/tv?code=…` approval URL.
The user scans it with a phone instead of typing a URL + code. The same endpoint with
`?target=remote` renders the QR for the Jarvis phone push-to-talk remote.

**2c. The TV's primary surface is Jarvis, not the home dashboard.** The phone-as-mic / TV-as-display
experience already exists for Fire TV (`GET /api/jarvis/tv` + `GET /api/jarvis/remote`): you push to
talk on your phone, the answer shows (and is spoken) on the TV. Samsung opens `/api/jarvis/tv`
top-level (full experience for free); Roku rebuilds it natively (scan-to-talk QR + live conversation
polled from `/api/jarvis/history`; Smart Home device grid is the secondary `*` screen). Roku
**displays** the conversation but does not speak it (no public Roku channel TTS API). Fire TV
(and Samsung) **speak** the answer via the server's **Gemini neural TTS** (`POST /api/voice/synthesize`);
Fire TV falls back to the on-device engine through a native `OshalTTS` JS bridge — Fire OS ships **no
default TTS engine**, so the app forces one (Pico).

**2d. Room targeting (multi-TV without echo).** All surfaces on one user share the per-user Jarvis
thread (`jarvis-${sub}`), so two TVs both on the Jarvis screen would both display *and speak* every
answer. To fix that, each TV claims a **room** → its own session thread (`jarvis-${sub}-<slug>`,
"Main" = the default). TVs register + heartbeat via `POST /api/jarvis/tv/register`; the phone lists
active rooms via `GET /api/jarvis/tv/rooms` and sends `/ask` with the chosen room's `sessionId`, so
**only that screen** shows + speaks the reply. Each TV's scan-to-talk QR carries `?room=<slug>`, so
scanning a given screen pre-selects it on the phone. Registry is in-memory + TTL'd (heartbeat ~30s),
same volatility model as pairing. Back-compatible: a TV with no room → the default thread.

**3. Surfaces stay surfaces (ADR-036/047).** No reasoning, no aggregation, no credentials on the
device beyond the host URL (+ a paired token on Roku). All reasoning + device aggregation remain on
the host/cloud swarm and keep cost capture + per-user scoping.

**4. A documented four-phase registration recipe** (account → identity/signing → sideload/verify →
submit/certify) per platform, under the **business email**, with a decision rule for future
platforms: *has a real browser the user can log in through?* → web `?tv=1`; *no?* → native + the
device-link rail. Captured in the runbook so each new platform is mechanical.

## Consequences

- **New server surface area is small + additive:** the existing `createTvTokenAuthMiddleware` now
  also reads the token from a header, and the pairing rail gained `GET /api/tv/pair/qr` (+ `qr_url`
  in the start response). No new mount, no `callerSub` change — the home routes are as the Fire TV
  work left them. The QR endpoint is public but only ever encodes auth-gated app URLs (no secret).
- **Security:** a new (signed, short-TTL, secret-gated, approval-requires-OIDC) bearer path into the
  home API. It must be covered by a security review before public exposure — consistent with
  ADR-047 gating the privileged LAN ingress. Fails closed when no signing secret is set.
- **Roku is a real native app**, not a wrapper — more code to maintain (BrightScript) and its own
  store certification. v1 is Jarvis-first (scan-to-talk QR + live conversation) with the Smart Home
  device grid as the `*` screen; Roku spoken TTS, schedules UI, and a host-entry screen are backlog
  (the web surfaces already have them).
- **`?tv=1` benefits every future web-TV platform for free** and is the cheapest path; native +
  pairing is reserved for genuinely browserless platforms.
- **Assets are placeholders.** Roku PNGs + the Samsung icon are brand-colored placeholders at the
  correct dimensions; real artwork is required before store submission (noted in each package).
