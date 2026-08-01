# Jarvis voice and visuals — next steps

- Status: focused open-work backlog
- Baseline: production slice on `main` as of 2026-07-11
- As-built reference: [Jarvis architecture and flow](../architecture/jarvis-architecture-and-flow.md)
- Native background reference: [Jarvis native background wake word](../architecture/jarvis-native-background-wake.md)
- Voice/privacy decision: [ADR-084](../adr/084-deterministic-speaker-diarization-and-voice-profiles.md)

## Shipped baseline

Jarvis can conditionally turn the central cloud into a persisted image response, narrate it, reverse
the animation, and rematerialize the exact artifact from Discussion. The server accepts 15 strict
visual kinds: `weather`, `priority-email`, `table`, `chart`, `summary`, `timeline`, `diagram`,
provider-bound `gallery`, `map`, `gauge`, `checklist`, `agenda`, `comparison`, `profile`, and
trusted-receipt `image`. Completed delayed work may use all 15. A direct `/ask` turn remains orb + voice/text by default;
only an explicit request for the exact `timeline` or `diagram` kind may pass the server gate, and only
when no hand-off is attempted, the model claims no sources, and every displayed fact is already in
the authoritative answer. Visual artifacts are deterministic SVGs, owner-scoped, immutable per
source job, privately served, and included in privacy export/deletion.

Manifest-worker bot-node results are saved durably before ticket completion bookkeeping. Explicit
live weather, priority-inbox, and read-only Walmart searches become strict server-authored provider
intents, execute through the owner's request-scoped connector with model `none`, and add typed
NWS/Gmail/Walmart records to that completion's hidden metadata. Exact allowlisted Codex command
capture remains a compatibility path. The route deterministically rebuilds provider-owned visual fields from those records and
strips model-authored provider fences. This is trusted control-plane metadata, not cryptographic
attestation from NWS, Gmail, or Walmart.

Live Walmart search records can now derive a URL-free gallery spec. Jarvis fetches only the exact
approved Walmart image CDN over credential-free HTTPS, rejects redirects and private-network
resolution, caps streamed bytes and decoded pixels, verifies MIME plus raster magic, and transcodes
JPEG/PNG/WebP to bounded metadata-free PNG. Those bytes are embedded in the authenticated,
owner-scoped SVG; neither a model URL nor a provider URL becomes a browser image request. If no
image survives receipt, the completed Markdown table remains the stage fallback.
The controller persists the exact server-authored provider intent with the worker completion;
automatic summaries/galleries require that matching intent, preventing a search record inside mixed
or action-oriented work from replacing the full outcome. Immutable retries reuse an existing
grounded-spec match before refetching mutable CDN bytes.

Model-authored Markdown image syntax is inert and does not initiate an image request. Automatic
materialization and Discussion replay require exact same-origin metadata for the owner-scoped SVG
artifact URL. A DOM-free response registry foundation now provides exact-key dispatch, validation,
capability filtering, cancellation, ordered failure isolation, and safe fallback descriptors; wiring
Jarvis and non-Jarvis surfaces to it remains open.

The orb also exposes opt-in ambient listening with a configurable assistant name and wake phrases,
text transcript retention, daily extractive review, confirmation-only follow-up proposals, and the
deterministic speaker/profile path from ADR-084. Browser ambient mode works only while Jarvis is open
and visible. Voice matching is not authentication.

The mobile center response is a fixed-height, width-bounded slot: one user line plus two answer lines
can appear without pushing the controls or growing page scroll height. Center copy and response-stage
captions hard-wrap hostile unbroken tokens. Discussion contains incidental horizontal overflow while
tables and fenced code retain local, intentional scrolling.

For a closed page on Windows, OSHAL Node now provides a separate local wake-only listener. It does
not extend browser transcript capture into the background; after the exact wake phrase, it opens the
authenticated Jarvis surface and hands command capture back to the normal voice path.

## Automated evidence cutoff (2026-07-12)

- 248 Vitest tests passed across 15 focused files covering typed visuals, secure receipt and
  immutable replay, deterministic Walmart routing/execution, bounded provider transport, mixed-task
  suppression, provider grounding, manifest persistence, privacy, schema policy, and the response registry.
- 34 Playwright tests passed across the 3 Jarvis rich-response, response-stage, and audio-lifecycle
  files, including hostile Markdown-image and invalid-artifact-URL regressions.
- Root TypeScript typecheck passed. The earlier broader 219-test baseline, OSHAL Node package build,
  and in-memory Windows exact-phrase wake smoke remain historical evidence and were not rerun for this
  focused visual change set.
- The authenticated live Walmart journey passed with deterministic provider/model-none execution,
  one trusted catalog record, two direct product links, two embedded PNG receipts, no remote SVG
  image request, and no cart/order action (ticket `910b03ec-6219-43ad-8a5d-ff008fa23070`, artifact
  `2fd7643a-3009-4717-9007-dcd542bf01bf`).

These numbers are automation evidence, not completion of the manual gates below. Provider routing is
a bounded weather/priority-inbox guard plus an explicit read-only Walmart catalog guard; order,
cart, mixed-retailer, and implementation requests stay on the normal routing path. Current weather proof covers a named US location sent
directly or supplied after Jarvis's missing-location clarification; it does not use device geolocation.
Gmail fetches `newer_than:1d` with `maxResults=25`, and a delayed visual contains at most six
provider-priority rows. No seeded OSHAL Gmail E2E has run. Provider records cross a trusted
control-plane boundary and are **not cryptographic attestations** from NWS, Gmail, or Walmart.

## Open-item index (2026-07-11)

The mobile wrapping defect is closed in automation; it does not need a new backlog item. The remaining
work is explicit below.

| Item | Priority | What remains open |
|---|---:|---|
| JVV-001 | P0 | Seeded authenticated Gmail worker-to-visual acceptance and unavailable-data fallbacks. |
| JVV-003 | P0 | One queue-backed lifecycle proof without injected terminal worker state. |
| JVV-004 | P0 | Real assistive technology, native zoom/forced colors, long translations, physical iOS/Android, safe areas, and dynamic browser chrome. |
| JVV-006 | P1 | General trusted image/gallery/document ingestion, map/forms, and separately sandboxed HTML preview; the bounded live-Walmart gallery slice is shipped. |
| JVV-007 | P1 | Wire the shared registry into Jarvis/other surfaces and replace the floating Mermaid CDN import with a reviewed vendored or exact-pinned asset. |
| JVV-008 | P1 | Audited preview/confirm workflows for reminders, events, and tasks. |
| JVV-009 | P1 | Privacy-safe response metrics and an explicit artifact-retention policy. |
| JVV-010 | P1 | Calibrated speaker attribution and full unknown-person/profile review acceptance. |
| JVV-012 | P1 | Selectable TTS connectors plus a rights-cleared local/private voice path. |
| JVV-011 | P2 | Physical Windows/signing acceptance and separately approved macOS/Linux helpers. |
| JVV-013 | P2 | Separately reviewed native all-day transcript capture while Jarvis is closed. |

JVV-002 (provider-field grounding) and JVV-005 (server-owned visual eligibility, including the narrow
explicit structural exception) are complete.

## Return-session acceptance checklist

Run these in order against a private test tenant. Use a seeded test mailbox; do not use a personal
mailbox for screenshots or shared evidence.

1. **Direct-turn guard:** ask “hello,” then ask a short question Jarvis answers directly. Confirm both
   stay orb + text/voice and create no artifact. Try all 15 kinds without an explicit structural
   request and confirm they remain suppressed. Then explicitly request a timeline and a diagram whose
   facts are all in the answer; each exact kind may materialize. Repeat with a missing fact, source
   claim, kind mismatch, negation, capability question, and hand-off; each must fail closed to text.
2. **Live weather:** request a named US city, then repeat with “weather where I live” and provide the
   city on the next turn. Confirm the hand-off acknowledgement has no visual; after the worker
   finishes, say plain “yes” to the result offer and compare the revealed visual with the captured
   NWS record. An unrelated turn must clear the offer and must not let a later “yes” open stale work.
3. **Live important mail:** seed unread, provider-`IMPORTANT`, provider-`STARRED`, and ordinary
   messages. Confirm the acknowledgement is text-only and the delayed result preserves sender,
   subject, receive time, unread state, and importance semantics without exposing message bodies.
4. **Narration and recovery:** interrupt narration with Stop, ask a new question immediately, and
   verify the older response cannot clear or overwrite the newer state.
5. **Discussion durability:** let a visual archive, reload the page, open Discussion, and rematerialize
   it. The artifact URL and content hash must remain unchanged.
6. **Delayed work:** trigger a real worker hand-off that returns a visualizable result. Confirm the
   acknowledgement has no visual, then the completed result is summarized once and saved into the
   original Discussion thread with its visual.
7. **Ambient identity:** rename the assistant to “Computer,” set “Hey Computer,” enable ambient mode,
   and confirm the configured bounded start-of-utterance phrase, command dispatch, pause-during-TTS,
   visible-page behavior, and the transcript day view. Do not infer general semantic wake routing.
8. **Daily review and consent:** enable review/follow-up suggestions, seed “remind me” language, and
   confirm Jarvis proposes an action but creates nothing without explicit confirmation.
9. **Speaker/privacy boundary:** when the diarization sidecar is available, enroll and forget `My
   Voice`; confirm stable `Unidentified Person N` labels, rename/merge/unassign/forget behavior,
   same-private-org member assignment, public-tenant assignment denial, and no retained raw audio.
   Do not treat a voice match as identity proof.
10. **Accessibility and responsive layout:** automated coverage now includes keyboard use, reduced
    motion, 200%-equivalent sizing, and `320x568` reply/caption stress cases. On a physical phone,
    repeat with a long unbroken text reply and long visual caption: document width must stay bounded,
    reply/caption `scrollWidth` must not exceed `clientWidth`, and controls/page scroll height must not
    move when the reply arrives. Then complete screen-reader, safe-area, and dynamic-browser-chrome
    checks. The orb, Always listening control, Stop, and Discussion must remain reachable and announced.
11. **Erasure:** export the test owner’s data, then use the confirmed privacy-delete path. Verify the
    transcript, reviews, voice profiles, Jarvis tasks, visual artifacts, and ephemeral answer cache
    are gone without affecting another owner.

Record failures with the prompt, session/job/ticket IDs, viewport, provider state, and a screenshot.
Never put mailbox content, transcript text, voice embeddings, or tokens in logs/evidence.

## P0 — prove and harden before broad rollout

### JVV-001 — authenticated live-provider acceptance suite

**Status: partial / open.** The NWS worker has a live CLI smoke. A read-only authenticated Gmail
connector probe verified the expected metadata/priority-flag shape without publishing mailbox
content, but the OSHAL test tenant has no linked Gmail account, so the real communications-bot →
visual → Discussion path has not run against a seeded mailbox. The labeled demo screenshots are
local and untracked unless explicitly staged later; they are not live-provider evidence.

Weather proof covers a named US location supplied directly or after Jarvis asks for the missing city;
it does not prove device geolocation, international weather, or every phrasing. Gmail acceptance is
additionally bounded to the `newer_than:1d`/25-message fetch window and a maximum of six
provider-priority rows in the visual; it is not proof of complete-mailbox coverage.

> **LIVE WEATHER E2E: PASSED (2026-07-10).** Redacted runs covered both a named-US-location request
> and “weather where I live” followed by the city: text-only clarification/acknowledgement → dedicated
> weather worker → trusted NWS record → fact-locked delayed SVG → plain-yes reveal and Discussion
> replay. Repeated owner reads had an identical hash, while a different owner received 404 and an
> anonymous caller received 401.

**Next:** add an operator-run acceptance fixture using a seeded test Gmail account. Cover
answer → typed spec → SVG → narration → archive → reload/rematerialize, including connector-offline,
empty-inbox, and artifact-load failure paths.

**Done when:** the suite runs without response mocks, records redacted evidence, confirms no mailbox
body leakage, and proves text/orb fallback for every unavailable-data case.

### JVV-002 — field-level provider grounding

**Status: done in the implemented slice (2026-07-10; Walmart intent path extended 2026-07-12).**
Strict server-authored provider intents and exact allowlisted successful command events are
normalized into bounded NWS/Gmail/Walmart records outside model text and persisted with the
manifest-worker completion. Weather and priority-email schemas require provider references; the
grounding adapters replace model-authored weather/mail facts with captured values and fail closed on
missing or unknown records. Gmail suggestions must cite a real message and remain explicitly labelled
as Jarvis suggestions.

Mutation coverage pins temperature, forecast periods, sender, subject, receive time, unread,
`IMPORTANT`, and `STARRED` fields. Model-authored provider fences are stripped. The guarantee is a
typed control-plane boundary, not provider-signed cryptographic attestation; compromised worker or
controller defense remains outside this item.

### JVV-003 — real delayed-task lifecycle test

**Status: partial / controller integration complete (2026-07-10).** The Express-level acceptance
test crosses `/ask`, trusted-service identity, durable task/ticket state, completion claiming, Jarvis
summary, the real renderer/persistence service, original-session Discussion history, owner-scoped
artifact reads, and byte-identical reload. It proves the hand-off acknowledgement has no visual and
the completed result is stored once. External bot and database implementations are deterministic
in-memory adapters; the worker completion is injected rather than won and executed through the real
queue call-out. A separate manifest-worker boundary suite proves remote bot-node result persistence
precedes terminal ticket status and deduplicates retries. Live-provider acceptance remains JVV-001.

**Next:** join those two boundaries in one automated queue-backed test, or capture a redacted live
run that proves the generic call-out winner executes and lands the same durable Discussion artifact.

**Done when:** hand-off → call-out winner → remote worker → durable completion → one Jarvis summary →
one immutable artifact → original Discussion is proven without injecting terminal worker state.

### JVV-004 — accessibility and interaction sign-off

**Status: partial / manual gates open.** Automated browser coverage now pins keyboard activation,
focus containment/restoration, equivalent authoritative text and image alt, reduced motion, 44px
targets, 200%-equivalent text sizing, Stop/Discussion reachability, interruption races, and the
`320x568` mobile response contract. Long unbroken center copy and captions remain contained; reply
arrival does not shift controls or increase page scroll height. The automated mobile wrapping defect
is closed. Real NVDA/JAWS/VoiceOver, native browser 200% zoom, forced-colors/high-contrast, long
translations, physical iOS/Android touch, safe-area, and dynamic-browser-chrome testing remain manual
release gates.

**Manual release work only:** run real NVDA, JAWS, and VoiceOver; native 200% zoom and forced-colors/
high-contrast; long translations; and physical iOS/Android touch testing. The automated reduced
motion, target-size, equivalent-text/alt, keyboard/focus, responsive-layout, and interruption checks
are complete and are not stale next steps.

**Done when:** the documented matrix passes with no critical WCAG 2.2 AA issue and every visual’s alt
text conveys its decision-relevant content, not just its type or item count.

### JVV-005 — server-owned visual eligibility

**Status: done; policy evolved (2026-07-11).** The route still owns eligibility. Direct `/ask` results
are text/orb-only unless the original turn explicitly requests the exact `timeline` or `diagram` kind.
That structural exception requires one valid matching spec, no attempted hand-off, no model-authored
source reference, and every visible fact and relationship in the authoritative answer; the server
then supplies its own answer source. Weather, priority email, table, chart, summary, implicit visual
mentions, capability questions, product/code requests, acknowledgements, timeouts, errors, malformed
or duplicate fences, and mismatches remain suppressed.

## P1 — expand the response language safely

### JVV-006 — additional typed response kinds

**Status: partial — bounded timeline/diagram plus a provider-bound Walmart gallery shipped
(2026-07-12).** Timeline accepts two to six
bounded items. Diagram accepts two to eight uniquely identified nodes and one to twelve valid,
non-self, non-duplicate, acyclic edges, then renders the graph deterministically. It has no raw
Mermaid, SVG, HTML, URL-fetch, or executable-content field. Both structural kinds have escaped
display text and decision-relevant accessible alt text, and both are available for completed delayed
work. The narrow direct structural policy is documented in JVV-005. A live Walmart search may also
derive one four-item gallery from a deterministic `product-search` provider record (with exact-command
capture retained only as compatibility). Its visual spec contains opaque item
references and display facts only. A server receipt pipeline applies an exact CDN allowlist, public
network check, no-redirect policy, timeout and streaming byte cap, claimed/actual MIME verification,
pixel cap, metadata-stripping PNG transcode, hash provenance, owner-scoped persistence, and a
table/text fallback. The client still loads only its authenticated same-origin SVG.

Still generalize the receipt policy beyond the Walmart catalog and add allowlisted `map`,
`document/download`, standalone trusted `image`, and confirmation-form contracts. A model URL remains
untrusted and can never enter the receipt path. Add an explicitly sandboxed `html-preview` contract only for inert,
sanitized content rendered in a nested iframe with a restrictive CSP; never accept arbitrary active
model-authored HTML/JavaScript in the application document.

Before enabling general third-party image retention, define per-owner aggregate byte quotas,
retention/cleanup policy, provider licensing terms, and content-hash deduplication. The shipped
Walmart slice already bounds concurrent decode work, source pixels, individual PNG bytes, and total
artifact bytes, but owner-lifetime retention still follows the existing account/export/delete policy.

**Done when:** each type has a strict bounded schema, deterministic/sandboxed renderer, accessible
fallback, provenance, privacy behavior, and failure tests; HTML preview cannot execute script,
navigate the parent, submit a form, or make unapproved network requests; unsupported types remain
text-only.

### JVV-007 — portable renderer across OSHAL surfaces

**Status: registry foundation implemented; surface adoption open (2026-07-11).** The shared DOM-free
registry normalizes exact bounded keys, rejects duplicates and wildcard/path-like identifiers,
validates blocks, filters per-surface capabilities, preserves source order across async rendering,
isolates component failures, supports cancellation, and returns safe fallback descriptors. It does
not construct DOM or interpret arbitrary component names.

Next, adapt Jarvis to consume the registry, then add one cockpit concierge, Electron/native shell,
and TV fallback consumer. Define end-to-end capability negotiation so a TV can request a simpler
artifact without changing the authoritative answer or its provenance.

As part of the Jarvis adapter, remove the current floating `mermaid@11` jsDelivr module import. Serve
a reviewed vendored build or an exact version/hash under the application security policy, retain
Mermaid's strict mode, and prove offline/text fallback. The typed visual-artifact path itself does not
execute Mermaid, but Discussion should not depend on an unpinned third-party module at render time.

**Done when:** one typed response fixture renders equivalently in Jarvis, one app concierge, the
desktop shell, and a TV/client fallback, with the same source/provenance semantics.

### JVV-008 — confirmation-to-action workflow

**Status: open.**

Turn ambient review proposals into allowlisted preview/confirm flows for reminders, calendar events,
and OSHAL tasks. Creation must use the caller’s connector, an idempotency key, and an audit event;
dismissal must have no side effect.

**Done when:** “the operator, remind me…” produces a proposal, Jarvis later asks for confirmation, one
confirmation creates exactly one intended item, denial creates nothing, and retries cannot duplicate
the action.

### JVV-009 — observability and artifact lifecycle

**Status: open.**

Add privacy-safe metrics for directive rejection, render/persist/load failure, fallback rate,
materialization latency, archive replay, and storage growth. Define artifact retention independent of
conversation text while preserving explicit export/delete guarantees.

**Done when:** operators can distinguish provider, schema, renderer, persistence, and client-load
failures without logging answer content, mailbox subjects, transcript text, or biometric material.

### JVV-010 — speaker calibration and unknown-person review UX

**Status: open.** The deterministic diarization/profile path exists, but it is not yet calibrated or
signed off as production speaker attribution.

Build a consented labeled evaluation corpus across microphones, rooms, overlap, short turns, and
accents; calibrate clustering/match thresholds and the margin rule. Test merge, rename, unassign,
forget, `My Voice` enroll/forget, same-private-org member assignment, public-tenant denial, and
historical display resolution in the Voice & Speakers surface.

**Done when:** repeatability remains deterministic, false-attribution and false-split rates are
reported for the pinned model/configuration, low-confidence speech stays unknown, and the UI never
implies that attribution is authentication.

### JVV-012 — selectable TTS connectors and rights-cleared private voices

**Status: selection slice SHIPPED 2026-08-01 (code; rides the next deploy) / private-voice path
open.** Shipped: `GET /api/voice/providers` lists every registered TTS provider with its LIVE
`getStatus` (unconfigured providers render as honest DISABLED options carrying the reason — never
selectable, enforced again server-side by `POST /api/voice/prefs` → 400 `provider_not_configured`);
per-user provider+voice persistence in `voice_user_prefs`
(src/features/voice-providers/services/voice-prefs-store.ts — provider/voice IDs only, secrets stay
server-side); `/api/voice/synthesize` honors the caller's saved selection whenever the body names no
provider (explicit values always win), so Jarvis's existing speak path — and every other surface on
the voice rail — uses the chosen voice with zero surface changes; and a **Spoken voice** section in
the Jarvis settings panel (jarvis-ambient-ui.js): provider + voice selects, instant persist, and a
Preview button (explicit-selection synthesis; browser-voice fallback; failures stated). Failure
falls back through the existing server→browser speech chain without interrupting narration.
Guards: tests/unit/voice-prefs.spec.ts (`tts-picker-persists-and-honored`,
`unconfigured-provider-not-selectable`). Remaining open (unchanged below): the rights-reviewed
local provider, consented private voice-profile path, and license recording.

The framework already has a pluggable `TTSProvider`
contract, provider registry, `/api/voice/synthesize`, `/api/voice/voices`, and browser, Gemini, and
Google Cloud implementations.

Add provider/voice selection and preview to Jarvis settings, with owner-scoped preferences, explicit
fallback status, health/cost metadata, and a connector boundary that never exposes provider secrets to
the browser. Add a rights-reviewed local provider for built-in voices and a separately consented
private voice-profile path. A branded or “proprietary” voice must have recording consent, dataset and
model provenance, deletion behavior, and commercial output rights; do not represent a cloned profile
as a from-scratch proprietary model.

The paid Imagination Soft Voice AI product is currently treated as a Canva application, not an OSHAL
connector. No documented customer synthesis API or reusable buyer credential was identified. Do not
scrape Canva or depend on private endpoints; leave that connector unavailable until the vendor
provides a supported API, authentication contract, rate limits, and commercial/redistribution terms.

**Done when:** a user can select, preview, persist, and use an approved server or local voice in
Jarvis; failures fall back without interrupting narration; private profiles require explicit consent
and can be forgotten; provider/model/voice licenses are recorded; and connector secrets remain
server-side. The Imagination Soft option appears only after its supported vendor contract exists.

## P2 — separately reviewed background mode

### JVV-011 — native background wake-word companion

**Status: partial / Windows implementation complete (2026-07-10).** The existing OSHAL Node
Electron companion now uses the installed offline `System.Speech` engine with an exact configurable
grammar, explicit microphone opt-in, tray/settings state, single-owner microphone lifecycle, a
wake-only 15-second handoff into the OIDC Jarvis frame, bounded command capture through the normal
voice/Jarvis routes, and teardown on pause/off/sign-out/quit. It adds no second control plane or
durable raw-audio path. The in-memory offline recognizer smoke and automated lifecycle/security tests
pass.

**Still open:** run the physical-microphone false-wake/sleep/network acceptance matrix on target
Windows hardware, select the Windows release-signing certificate, and validate the SmartScreen-signed
installer. macOS/Linux remain fail-closed until their signed/entitled offline helpers, model
licensing/size, packaging, and autostart strategy are approved.

Browser “always listening” intentionally stops when Jarvis is hidden or closed. A true room/desktop
assistant requires a signed native companion with local wake-word detection, explicit OS microphone
permission, visible capture state, bounded encrypted transport, update/revocation controls, and a
separate threat/privacy review.

**Done when:** the companion can wake Jarvis while the web page is closed without storing raw audio,
survives sleep/network transitions safely, provides an unmistakable hardware/OS-visible off state,
and passes security, privacy, battery, and false-wake acceptance gates.

### JVV-013 — native ambient transcript mode while Jarvis is closed

**Status: product intent / not implemented.** Browser ambient mode retains finalized transcript text
only while the Jarvis page is open and visible. JVV-011 is deliberately wake-only when the page is
closed. It does not provide the originally requested all-day room transcript, end-of-day review, or
closed-page speaker attribution.

Design this as a separate, explicitly consented native mode rather than silently broadening the wake
listener. It requires an unmistakable persistent recording indicator and immediate hardware/OS-visible
off control; bounded in-memory audio chunks; local voice activity/diarization before any disclosed STT
transfer; encrypted owner-scoped transcript retention; battery/network/backpressure controls; pause
during calls, TTS, lock, and sign-out; deletion/export; update revocation; household/guest notice; and
a dedicated privacy/threat review. Raw audio must still be zeroed after processing and never become an
all-day recording archive.

**Done when:** on an approved signed native client, an opted-in user can close Jarvis, collect a full
day of timestamped attributed/unattributed text, review the transcript and extractive summary, receive
confirmation-only follow-up proposals, pause or erase capture immediately, and verify that no durable
raw audio or cross-owner data exists. Sleep, offline buffering, battery, false attribution, bystander
notice, and OS permission/revocation acceptance must pass before release.

## Non-negotiable regression guards

- No visual on a direct turn except the server-gated, explicitly requested, exact-kind `timeline` or
  `diagram` whose complete visible content is already in the authoritative answer. Greetings,
  ordinary answers, acknowledgements, errors, clarifications, timeouts, and hand-offs stay text-only.
- No fabricated text-picture fallback when an artifact is unavailable.
- No arbitrary model-authored HTML, script, URL, or action execution.
- No model-authored Markdown image may auto-load; only exact owner-scoped artifact metadata may enter
  automatic materialization or replay.
- No mobile reply or caption may grow the document horizontally or shift the primary controls when it
  appears; intentional wide tables and fenced code scroll only inside their bounded elements.
- No cross-owner artifact, transcript, review, or voice-profile access.
- No durable raw audio; no voice attribution used for authentication or authorization.
- No reminder, event, message, purchase, or task creation without an explicit allowed confirmation
  workflow.
