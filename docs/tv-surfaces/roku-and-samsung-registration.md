# TV Surface Registration & Publishing — Roku, Samsung, and the repeatable pattern

> **How to register, sideload, and publish an OSHAL Home TV app on each streaming platform.**
> The Fire TV app ([`packages/oshal-firetv`](../../packages/oshal-firetv/)) is already built; this
> runbook covers the next two — **Roku** ([`packages/oshal-roku`](../../packages/oshal-roku/)) and
> **Samsung/Tizen** ([`packages/oshal-samsung-tv`](../../packages/oshal-samsung-tv/)) — and the
> generic recipe for adding any future TV platform (Apple TV, Android/Google TV, LG webOS, Vizio).

This doc is the **registration** counterpart to each package's README (which covers building +
sideloading). When you ask *"how do I get the TV app registered/published on \<platform\>?"*, the
answer follows the four phases below; only the per-platform appendix changes.

---

## Rule 0 — Register every developer account under the business email

Same rule as [partner-app-registration.md](../partner-app-registration.md): create the **Roku**,
**Samsung**, **Amazon**, **Apple**, **Google Play**, and **LG** developer accounts under
**`maintainer@emeraldcoastsystemsgroup.com`** — never a personal address. That account receives
certification correspondence, store-policy notices, signing-cert expiry alerts, and payout/identity
verification. One business identity owns every store relationship.

> Exception that already exists: the **GCP/Google** org is owned by `owner@example.com`
> (deliberate, see the GCP memory). The Google OIDC login the TVs use rides that. Store/developer
> accounts (Roku/Samsung/Amazon/Apple/LG) are separate and use the business email.

---

## The four phases (every platform)

| Phase | What | Reusable? |
|---|---|---|
| **1. Account** | Create the platform's developer account (business email) + accept agreements. | Once per platform. |
| **2. Identity / signing** | The cert or key that signs your package + a device-level dev mode for sideload testing. | Once per platform (certs expire — note renewal). |
| **3. Sideload + verify** | Put the package on a real device in developer mode and confirm it works end-to-end (pairing/login → devices → control). | Every build. |
| **4. Submit + certify** | Upload to the store, fill metadata + assets, choose distribution (private/beta vs public), pass certification. | Every release. |

The **OSHAL surface contract** that every TV app must satisfy before Phase 4:

- Its **primary surface is Jarvis** — the phone-as-mic / TV-as-display experience: push to talk on
  your phone (`/api/jarvis/remote`, reached by scanning the TV's QR), the answer shows + is spoken on
  the TV (`/api/jarvis/tv`). The Smart Home dashboard is the secondary surface.
  - **Web-capable platforms** (Samsung Tizen, LG webOS, Android/Google TV, Apple TV via web view):
    point the top window at `…/api/jarvis/tv` (and `…/api/home/ui?tv=1` for Smart Home — the `?tv=1`
    flag enables the dashboard's built-in D-pad spatial navigation). OIDC login runs top-level.
  - **No-browser platforms** (Roku): rebuild natively over the JSON APIs — Jarvis from
    `/api/jarvis/history`, Smart Home from `/api/home/devices` + `/scenes` + `/control` — sending the
    `X-OSHAL-TV-Token` header, and authenticate via **device-link pairing** (below).
- It authenticates **as the signed-in OSHAL user** and stays a **surface** (ADR-047): no reasoning,
  no aggregation, no credentials beyond the host URL (+ a paired token on Roku).

### Device-link pairing (the browserless-auth rail)

One shared rail serves both Fire TV (cookie) and Roku (header):
[`src/app/routes/tv-pairing-routes.ts`](../../src/app/routes/tv-pairing-routes.ts). Its
`createTvTokenAuthMiddleware` injects an authenticated `req.oidc` from the token, so every
`requiresAuth` route (including `/api/home`) resolves the paired user with no per-route change.

```
TV → POST /api/tv/pair/start                 → { user_code, device_code, verification_uri, interval }
(human opens verification_uri = <host>/tv on a phone, signs in with Google, enters user_code)
phone → POST /api/tv/pair/approve {user_code} → binds user_code → user sub, mints a signed token
TV → POST /api/tv/pair/poll {device_code}     → { status:"approved", token }   (then call /api/home/*)
```

The TV then presents the token on every `/api/home/*` call — Fire TV as the `oshal_tv` **cookie**,
native Roku as the **`X-OSHAL-TV-Token`** (or `Authorization: Bearer`) **header**. Tokens are
HMAC-signed `v1.<payload>.<sig>`, 30-day TTL, not stored server-side; a `401` tells the TV to
re-pair. `POST /api/tv/pair/revoke` (requiresAuth) signs out **all** of a user's TVs at once
(a durable per-user `min_iat` watermark), and rotating the secret invalidates every token globally.

**Required env:** a signing secret must exist — `SESSION_SECRET` (or `AUTH_SESSION_SECRET` /
`KEYCLOAK_CLIENT_SECRET`). With none set, the pairing routes throw (pairing unavailable).

### Room targeting (multi-TV without echo)

All of a user's surfaces share the default Jarvis thread, so two TVs both on the Jarvis screen would
each show **and speak** every reply. To target one screen, each TV claims a **room** (its own session
thread): it registers + heartbeats via `POST /api/jarvis/tv/register {room}`, the phone lists active
rooms via `GET /api/jarvis/tv/rooms`, and its **"send to: [room]"** selector routes `POST /api/jarvis/ask`
to that room's `sessionId` — so only the chosen TV shows + speaks. Each TV's scan-to-talk QR carries
`?room=<slug>` so scanning a screen pre-selects it on the phone. Room is set per surface: web TVs via
`…/api/jarvis/tv?room=<room>` (Samsung launcher field), Roku via its registry `room` key. No room →
the default thread (back-compatible).

---

## Appendix A — Roku

**Platform shape:** native **BrightScript + SceneGraph** channel. No browser → uses device-link
pairing + the JSON API. Package: a zip with `manifest` at the root.

### Phase 1 — Account
1. Create a **Roku account** (business email) and a **Roku Developer** account at
   <https://developer.roku.com>. Free.
2. Link at least one Roku device to that account (needed for Beta-channel testing).

### Phase 2 — Identity / signing + dev mode
- Roku has **no developer certificate to manage** — the Developer Dashboard signs channels at
  publish time. For sideload testing you only need **Developer Mode** on the device:
  on the remote press `Home ×3, Up ×2, Right, Left, Right, Left, Right`, accept, set a dev-server
  password, and note the device IP.

### Phase 3 — Sideload + verify
1. Replace the placeholder PNGs in `packages/oshal-roku/images/` with real artwork at the exact
   sizes ([images/README.md](../../packages/oshal-roku/images/README.md)).
2. Zip the channel **contents** (manifest at zip root): `zip -r oshal-roku.zip manifest source components images`.
3. Browse to `http://<roku-ip>`, log in with the dev password, upload the zip in the
   **Development Application Installer**, **Install**, and run it.
4. Verify: pairing **QR** shows → scan it on your phone → sign in + approve → Jarvis screen loads →
   scan the "talk" QR and speak → your words + Jarvis's reply appear on the TV → press `*` for the
   Smart Home device grid → OK toggles a device. `telnet <roku-ip> 8085` for logs.

### Phase 4 — Submit + publish
1. Developer Dashboard → **Manage My Channels → Add Channel**.
2. Choose distribution:
   - **Beta Channel** — invite-only, up to 25 testers, **no full certification**. Best for OSHAL's
     account-scoped utility nature; share the invite link.
   - **Public** — listed in the Channel Store; requires passing **Roku certification** (performance,
     stability, no crashes, correct metadata; content/billing checks apply only if relevant).
3. Upload `oshal-roku.zip`, fill name/description/category, upload **store artwork** (channel poster
   HD 290×218 / FHD 336×210, plus screenshots), set the supported regions, and submit.
4. Certification turnaround is typically a few days; fix-and-resubmit on any rejection notes.

> Roku note: `roUrlTransfer` validates TLS against the system CA bundle. The OSHAL host **must** be
> HTTPS with a CA-signed cert (the Cloudflare tunnel is fine). Plain-LAN `http://` works only from
> the dev console; self-signed certs fail.

---

## Appendix B — Samsung (Tizen TV)

**Platform shape:** **web app** (`.wgt`). Wraps the dashboard top-level via `?tv=1`. OIDC login
works because navigation is top-level (not an iframe).

### Phase 1 — Account
1. Create/sign in to a **Samsung account** (business email).
2. Register at the **Samsung Apps TV Seller Office** <https://seller.samsungapps.com> as a seller.
   A **free** app can register as an Individual/Company seller; **paid** apps require commercial
   seller verification (business documents / banking). OSHAL Home is free → free-seller path.

### Phase 2 — Identity / signing + dev mode
- Install **Tizen Studio** + the **TV Extensions**.
- In **Certificate Manager** create:
  - an **Author certificate** (your signing identity — back up the `.p12` + password), and
  - a **Distributor certificate** using the **Samsung** option (signs in with the Samsung account).
    For sideloading to a real TV, add that TV's **DUID** to the distributor profile.
- On the TV: **Apps → enter `12345` on the remote → Developer Mode ON → enter your PC's IP →
  restart**. Connect via Device Manager or `sdb connect <tv-ip>`.

### Phase 3 — Sideload + verify
1. Replace `packages/oshal-samsung-tv/icon.png` with real 117×117 artwork.
2. In Tizen Studio import as a **TV Web Application** → **Run As → Tizen Web Application**
   (or CLI: `tizen build-web -- .` then `tizen package -t wgt -s <cert-profile> -- .buildResult`,
   then `tizen install -n OshalHome.wgt -t <device-id>`).
3. Verify: launcher shows host → **Open Smart Home** → Google login on the TV → dashboard loads →
   D-pad moves focus, OK toggles a device / runs a scene.

### Phase 4 — Submit + publish
1. Seller Office → **Add New Application** (TV).
2. Upload the **signed `.wgt`**, set name/description/category, upload **screenshots + icons**,
   and pick **TV model-year / platform-version compatibility** (the `required_version` in
   `config.xml` and the supported product list).
3. Submit for **Samsung VD (Visual Display) certification**. Expect a content + functionality
   review; respond to any rejection notes and resubmit. Private/limited distribution options exist
   for closed testing — choose that if you don't want a public Smart Hub listing yet.

> The `tizen:application id` / `package` in `config.xml` are placeholders; Seller Office confirms or
> assigns the package id at registration — match `config.xml` to what it issues.

---

## Appendix C — Future platforms (the same recipe)

| Platform | Shape | Surface path | Account / signing | Notes |
|---|---|---|---|---|
| **Amazon Fire TV** *(built)* | Android (Fire OS) APK | native WebView → `/api/home/ui` | Amazon Developer Console; debug-key sideload, release-signed for Appstore | Already shipped — see `packages/oshal-firetv`. |
| **Android TV / Google TV** | Android APK | reuse the Fire TV WebView app (add `LEANBACK_LAUNCHER`, Play signing) | Google Play Console; Play App Signing | Closest reuse of the existing APK. |
| **LG webOS** | web app (`.ipk`) | top-level → `/api/home/ui?tv=1` | LG Seller Lounge; webOS CLI + dev-mode app on the TV | Same web pattern as Samsung. |
| **Apple TV (tvOS)** | native (SwiftUI/TVML) or web view | device-link pairing + JSON API, or a web view → `?tv=1` | Apple Developer Program ($99/yr); Xcode signing; App Store review | No general WebView focus model → device-link is the safe path. |
| **Vizio / others** | platform-specific | web `?tv=1` where a browser exists, else device-link | per-platform store | Decide web-vs-native by "does it have a browser the user can log in through." |

**The decision rule for any new TV platform:**
1. **Does it run a web app with a real browser engine?** → wrap the dashboard top-level at
   `/api/home/ui?tv=1` (Samsung/LG/Android-web). Cheapest path; no new server work.
2. **No browser / no top-level login?** → native client over the JSON API + **device-link pairing**
   (Roku/Apple TV). Reuse `/api/tv/pair/*` and `X-OSHAL-TV-Token` — already built; no new auth rail.
3. Either way it stays a **surface** (ADR-047): no reasoning, no aggregation, no creds on the device
   beyond the host URL (+ paired token).

The human registers the developer account + signs the package; Claude writes the app code and the
server rails. Keep the four-phase checklist per platform so a future release is mechanical.
