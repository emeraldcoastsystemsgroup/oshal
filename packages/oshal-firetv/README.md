# OSHAL Home — Fire TV app

A native Android (Fire OS) app that turns a **Fire TV Stick into an OSHAL Jarvis surface**:
a big-screen view of your Jarvis conversation that **reads answers aloud in a neural voice**,
shows your **tasks** and **live bots**, and is driven **by your phone as the microphone**.

It is a thin WebView client over OSHAL surfaces — it holds no device state and only one secret:
a signed pairing token. All reasoning lives on the OSHAL host + cloud swarm. This is the **Fire TV
extension node** from [ADR-047](../../docs/adr/047-smart-home-edge-agent.md) §5 (build-order phase 3):
*the Firestick is a surface, not the engine.*

## Why phone-as-mic (the hard constraint)

A Fire TV Stick **cannot hear you**: it has no built-in microphone, the **remote's mic is locked to
Alexa** (no third-party API), and Fire OS has **no Google speech engine**. So voice **input** happens
on your **phone** (whose browser can do speech-to-text); the **TV displays + speaks** the answer.

## How it works

```
 Phone (/api/jarvis/remote)            Fire TV app  ──loads──▶  /api/jarvis/tv
   push-to-talk dictation                                          │ polls /api/jarvis/history (conversation)
        │ POST /api/jarvis/ask  ───▶  Jarvis (existing bot)        │ polls /api/jarvis/tasks  (tasks)
        ▼                              writes the turn             │ polls /api/jarvis/overview (live bots)
   (same per-user session) ◀───────────────────────────────────── │ speaks new answers via /api/voice/synthesize
                                                                   ▼ (Gemini neural TTS; native Pico fallback)
```

Phone and TV share the caller's **default Jarvis session**, so a question asked on the phone shows
up — and is read aloud — on the TV.

## Sign-in: device pairing (no password typing on the remote)

Google blocks sign-in inside embedded WebViews, so the app uses an OAuth-device-grant-style flow
(see [src/app/routes/tv-pairing-routes.ts](../../src/app/routes/tv-pairing-routes.ts)):

1. The TV shows a **code** (`POST /api/tv/pair/start`) and a QR to `/tv`.
2. You open `/tv` on your **phone/PC**, sign in with Google normally, and **approve the code**
   (`POST /api/tv/pair/approve`, auth-gated).
3. The TV polls (`POST /api/tv/pair/poll`), receives a **signed HMAC token**, stores it, and sends
   it as the `oshal_tv` cookie. `createTvTokenAuthMiddleware` turns that cookie into an
   authenticated session server-side. Token TTL is **30 days**.

**Revocation:** `POST /api/tv/pair/revoke` (auth-gated) bumps a per-user `min_iat` watermark in
`tv_token_revocations`, so **"sign out all my TVs"** invalidates every existing token and survives
restarts. The watermark is checked (cached) only when a TV token is actually presented, so normal
session traffic pays nothing; the check fails open on a DB error (the signature is still verified).
Rotating `SESSION_SECRET` is the global nuke.

## Build the APK

> Built/verified on a machine with the Android toolchain installed under `C:\Android\Sdk` +
> Microsoft OpenJDK 17. The build is **not** wired into CI yet.

- **JDK 17**, **Android SDK** (platform 34, build-tools 34), `adb` on PATH. Easiest: open this folder
  in **Android Studio** → Build → Build APK(s).

```bash
cd packages/oshal-firetv
gradle wrapper --gradle-version 8.2      # one-time (or let Android Studio do it)
./gradlew assembleDebug                    # → app/build/outputs/apk/debug/app-debug.apk
```

## Install on a Firestick

1. Firestick: **Settings → My Fire TV → Developer options → ADB debugging = ON** (unlock Developer
   options by clicking the device name 7× under About). Note the device IP.
2. From the build machine:
   ```bash
   adb connect <firestick-ip>:5555
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Launch **OSHAL Home**. It defaults to `https://oshal.agenticfederal.us` (override via the MENU
   settings screen). Pair once; then talk from your phone.

## Audio / TTS

- The TV prefers the server's **Gemini neural voice** (`POST /api/voice/synthesize`, needs
  `GOOGLE_API_KEY`); it falls back to the device's **Pico** engine via the native `OshalTTS` bridge.
- **Gotcha:** Fire OS ships with no *default* TTS engine set, so device TTS is silent until one is
  chosen. The app forces Pico explicitly; we also set the device default:
  `adb shell settings put secure tts_default_synth com.svox.pico`.

## Remote / navigation

D-pad moves focus; CENTER activates; BACK = web history then exit; **MENU = host settings**. The TV
view is read-only (you talk from the phone), so D-pad is mainly for the settings screen.

## Scope / non-goals

- **Surface only** — no inference, device aggregation, or tokens beyond the pairing token.
- Does **not** reproduce Amazon's native Ring picture-in-picture overlay (closed Amazon integration).
- Complex Jarvis requests that hand off to the swarm depend on the swarm/ticket pipeline being up.

## Tests

`tests/firetv-tv-pairing.spec.ts` (Playwright) covers the auth gates, the server wiring, the
pairing→token→one-time-poll lifecycle, and that the TV/remote views render. Run with:

```bash
MOCK_OIDC=true PLAYWRIGHT_PORT=4458 npx playwright test tests/firetv-tv-pairing.spec.ts
```

The Android app itself has no instrumented tests yet (manually verified on-device).
