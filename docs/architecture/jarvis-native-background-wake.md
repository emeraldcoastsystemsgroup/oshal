# Jarvis native background wake word

## Status

OSHAL Node (`packages/oshal-chat`) is the native host for wake-word listening while the hosted
Jarvis page is closed. It reuses the existing desktop node and authenticated Jarvis surface; there
is no second controller, message bus, or LLM path.

The Windows implementation and offline synthetic smoke are complete. It is not yet a broadly signed
release: physical-microphone false-wake, sleep/network, battery, and SmartScreen-signed installer
acceptance remain open. macOS and Linux fail closed with a visible `UNAVAILABLE` state until a
signed, permission-entitled local helper is selected for those platforms.

The recognizer is intentionally bounded phrase routing: it accepts only the configured exact
`Hey <name>` grammar. It is not a general always-on speech recognizer, semantic router, speaker
authentication mechanism, or proof that arbitrary phrasing will wake the application.

This mode is **wake-only**. While the Jarvis page is closed it neither records a room transcript nor
feeds the browser's daily transcript review. Continuous transcript capture remains an explicit,
visible-page browser feature.

## Runtime flow

1. The signed-in user explicitly turns on **Listen while Jarvis is closed** in OSHAL Node Settings.
2. The renderer calls `getUserMedia({audio:true})`, allowing Chromium and the OS to request the
   microphone grant. It immediately stops that stream.
3. The Electron main process persists the opt-in and starts a Windows PowerShell child with an exact
   `System.Speech` grammar: `Hey <configured name>`.
4. Windows processes microphone samples locally in memory. The child can emit only three JSON event
   types: `ready`, `wake` (confidence only), or `error`. It has no filesystem or network code.
5. At confidence `>= 0.70`, the main process stops the child, opens the existing OIDC-backed Jarvis
   window, and sends a wake-only event that expires after 15 seconds. No command or audio is handed
   across this boundary.
6. The Jarvis page takes microphone ownership, captures at most 12 seconds of command audio (or stops
   1.1 seconds after speech ends), uses the existing `/api/voice/transcribe` endpoint, then calls the
   normal authenticated `/api/jarvis/ask` route.
7. When the Jarvis surface closes, OSHAL Node resumes the native wake listener if it remains
   enabled.

## User-visible state

The same state is shown in Settings and the OS system tray:

- `OFF`: no background microphone owner.
- `STARTING`: local recognizer is loading.
- `LISTENING`: exact wake grammar is active.
- `PAUSED`: paused by the user, visible Jarvis, or push-to-talk mic ownership.
- `TRIGGERED`: wake accepted and Jarvis is opening.
- `UNAVAILABLE`: no approved local helper exists for this OS.
- `ERROR`: identity, microphone, speech-engine, or process startup failed.

Closing the OSHAL Node window hides it to the tray only while background wake is enabled. Packaged
builds on a supported desktop platform also register login startup while enabled. **Turn off**,
**Sign out**, and **Quit** stop the child. Sign-out additionally clears the persisted user identity
and applicable OIDC cookies before the app can listen again.

## Privacy and security invariants

- Background wake cannot be enabled without a captured verified swarm `userSub`.
- Enabling is excluded from the generic settings writer; it is available only through the dedicated
  IPC invoked after the explicit microphone-permission gesture.
- The Electron permission handler allows audio media only from the local renderer or configured
  OSHAL origins. Camera and unrelated permissions are denied.
- The Windows helper has a one-phrase grammar. It does not produce free-form transcripts.
- Native wake audio is never written to disk, sent over the network, added to Discussion, or stored
  in OSHAL databases.
- The post-wake command uses the existing bounded browser recording and the voice route's memory-only
  multipart upload; raw command audio is not durably stored either.
- The wake handoff contains only the configured phrase, confidence, and timestamp, and expires after
  15 seconds.
- The actual command remains on the established Jarvis voice and `/api/jarvis/ask` path under the
  OIDC browser session.
- A single component owns the microphone at a time: native listener, visible Jarvis, or local
  push-to-talk.

## Verification

Automated coverage is in `tests/unit/oshal-chat-background-wake.spec.ts`. It pins identity gating,
configurable exact grammar, wake-only payloads, pause/off/sign-out-compatible teardown behavior,
unsupported-platform failure, and the absence of disk/network output in the generated Windows
helper.

Run:

```powershell
npm --prefix packages/oshal-chat run build
npm --prefix packages/oshal-chat run test:wake
npx vitest run tests/unit/oshal-chat-background-wake.spec.ts tests/unit/jarvis-ambient-client.spec.ts --reporter=dot
npx playwright test tests/jarvis-audio-lifecycle.spec.ts --reporter=line
npm run typecheck
node --check packages/oshal-chat/src/renderer/renderer.js
```

`test:wake` synthesizes "Hey Jarvis" into a `MemoryStream` and recognizes it with the installed
offline engine. It opens no microphone and creates no audio file.

Recorded verification cutoff (2026-07-11): 219 Vitest tests passed across 18 suites and 29
Playwright tests passed across the three
Jarvis rich-response, response-stage, and audio-lifecycle files. Within that baseline, the OSHAL Node
package build and root typecheck passed; 16 focused native/ambient tests and 7 browser
audio-lifecycle tests passed. The offline wake smoke recognized the synthetic phrase "Hey Jarvis" at
`0.987673938` confidence with `rawAudioStored=false`; it did not open the physical microphone.

This automated evidence is not physical-device or accessibility sign-off. Real microphone/room
false-wake testing, sleep/network/battery behavior, Windows code signing and SmartScreen, physical
assistive-technology/device testing, and speaker-attribution calibration remain open. Wake matching
is descriptive control input, never identity proof.

Provider-result acceptance is outside this synthetic wake proof. Separately, a named-US-location
Jarvis live-weather E2E passed through the deterministic worker, delayed visual, and Discussion.
Gmail is bounded to `newer_than:1d`, at most 25 fetched messages, and at most six priority rows in a
visual; no seeded OSHAL Gmail E2E exists. Provider records use a trusted control-plane boundary, not
cryptographic attestation from NWS or Gmail.

On a Windows acceptance machine:

1. Confirm **Settings > Privacy & security > Microphone > Let desktop apps access your microphone**
   is on.
2. Sign in to the swarm in OSHAL Node.
3. Enable background wake, approve the microphone request, and verify the tray says `Listening for
   "Hey Jarvis"` (or the configured name).
4. Close both Jarvis and OSHAL Node windows. Confirm OSHAL Node remains in the tray.
5. Say the exact phrase, then one command. Confirm Jarvis opens, stops recording after the pause, and
   the turn appears in Discussion through `/api/jarvis/ask`.
6. Exercise Pause, Turn off, Sign out, and Quit and verify the OS microphone-in-use indicator clears
   each time.

## Remaining platform/release decisions

Windows development and locally packaged builds use the installed offline `System.Speech`
recognizer and require an installed recognizer for the selected locale. Broad production
distribution still requires the normal Windows code-signing certificate/SmartScreen release
process; no signing identity is stored in this repository.

macOS needs a notarized helper or an embedded offline model, microphone entitlement,
`NSMicrophoneUsageDescription`, and a product decision on model size/licensing. Linux needs an
offline model/helper plus PulseAudio/PipeWire packaging and an autostart strategy. Until those are
chosen and signed, both platforms remain visibly unavailable rather than falling back to a
browser/cloud speech service.
