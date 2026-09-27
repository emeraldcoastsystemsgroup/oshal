# Central assistant — a workspace that follows the intent

Open [the interactive concept](nexus.html). This is a new standalone direction alongside the existing four layouts and three homebase presets, not a replacement for them.

## The experience

The assistant is the front door. Applications become capabilities it brings into the conversation, rather than places the user must navigate before asking for help.

The opening screen has a luminous particle core and a single request composer. The Vegas example moves through three visible, explicitly simulated tool stages. Then the same screen becomes a conversation alongside a task-specific workspace: calendar windows, trip summary, flight comparisons, preferences, source details and a Travel view. The assistant stays visible throughout.

Try this sequence:

1. Send the prefilled November Vegas request, or choose **Find my November escape**.
2. Inspect the two free sample weekends. The cheapest fictional offer on a busy weekend is deliberately excluded.
3. Type **after 3pm** or **nonstop**, or use the filters. The recommendation and flight cards change together. Conflicting filters produce an honest empty state.
4. Open **Calendar**, then **Travel**, then **Sources**. The original conversation remains alongside.
5. Inspect a fare and save it to the local shortlist. Nothing is reserved or placed on a calendar.
6. In **Preferences**, rename the assistant, change the example departure airport or set a budget.

Jarvis is a working name, editable in the prototype. Naming should remain independent from identity, permissions and the underlying routing. Motion has a visible off switch, respects reduced-motion preferences and stops while the page is hidden. The composer voice icon is a labeled sample request shortcut; the microphone is never accessed.

### Speaking presence

Choose **Play readback** beneath the core. A bundled, locally generated placeholder voice plays a fixed demonstration sentence. The particles spread into an irregular cloud, drift, and vibrate with the actual audio amplitude, then settle back into their resting form. **Stop readback** interrupts immediately. Replay starts from the beginning. The same control appears alongside the completed travel workspace.

The audio analyser measures the prerecorded waveform (RMS amplitude); this is not a timer pretending to follow speech. Movement uses a smoothed attack/release envelope and stable particle identities, so the cloud reforms rather than jumping to unrelated random positions. The recording is not a dynamic reading of current fares, filters or user text. Its expandable transcript and placeholder disclosure remain available without audio.

No autoplay, microphone permission, external speech service or account connection is used. The sample is generated with the installed Windows desktop voice and embedded as a local asset, so playback also works from the local HTML file without a server or fetch. Turning motion off freezes both the core and sound meter without stopping speech. An OS reduced-motion change disables motion without reloading. New conversations, workspace changes, page hiding and page exit cancel playback; stale decoding cannot restart a cancelled sample. Audio failures expose the transcript and allow retry.

This demonstrates the visual behavior, not the final voice personality. A production version should feed the authorised assistant audio stream into the same presentation envelope, independently of tool execution. Speaking never establishes that a tool succeeded or grants permission for an action.

## What is real and what is simulated

- **Real:** implemented local screen transitions, filters, date exclusion, sort order, accessible tabs/dialogs, editable name/preferences, local shortlist, canvas rendering, prerecorded audio playback and audio-reactive motion.
- **Fixture:** every person/profile assumption, date availability, itinerary, carrier, fare, source-read and tool stage. PNS/ATL/ORD and November 2026 are selectable/example assumptions, not discoveries about the user's location or calendar. Carrier names explicitly identify examples. Nothing establishes actual airline service on these routes.
- **Not invoked:** calendar accounts, Travel endpoints, Duffel, fare monitoring, assistants, provider generation, booking, payments or calendar writes. Fares are not live quotes. Shortlists exist in page memory only and reset on reload.
- **Supported demo intent:** the Vegas/November flight journey and its two text refinements. Unrelated requests produce a clear explanation of the prototype's limited scope, not an invented general-purpose answer.

## Grounding in the existing swarm

The inspected [Travel README](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/travel/README.md), [manifest](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/travel/oshal-app.yaml) and [route implementation](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/travel/src-routes/travel-routes.ts) describe and implement a user-scoped provider seam for flight search, preferences, saved observations, watches and concierge interaction. The declared Travel surface is `/api/travel/app`. Booking is an external provider handoff; OSHAL does not take payment or claim to book. Hotel/car demo or handoff behavior must not be presented as verified live search.

This prototype's **Open in Travel** changes a local workspace view; it does not launch that endpoint. Its name, routes and notes are grounding for an implementation path, not proof of a running, configured provider. The calendar aggregation/availability adapter and its exact authorization/time-zone behavior still need a bounded implementation assessment before any live “free weekend” claim.

## Production design contract

Prefer a typed, allowlisted **result-to-view contract**, not arbitrary model-generated HTML or JavaScript. The reasoning layer chooses among known components: availability calendar, result comparison, artifact/document preview, map when justified, source details and approved application handoff. The shell validates app ownership, destination, schema, version and current authority before rendering data or exposing actions.

The request lifecycle needs explicit states: clarification needed, permissions/setup needed, running, partial, ready, failed and cancelled. Stream actual tool receipts and bounded results into the workspace. The visible activity trail describes tool actions, not private reasoning. Cancellation and newer requests must invalidate stale completions.

For this specific journey, production acceptance would require:

- Explicit date year, departure airport, traveler count, budget meaning, trip length and calendar time zone. Use confirmed preferences or ask when missing; never infer an airport from a profile name.
- Authorization-scoped calendar availability; multiple calendars, all-day events, travel buffers and stale/partial reads. No access is **unknown**, not **free**. Travel receives availability windows, not unnecessary event titles or other household members' private records.
- Actual supplier offers with offer IDs, source/environment, checked time, expiration, outbound/return details, local time zones, taxes, fees, baggage and cancellation terms. Never rank incomplete totals as confidently cheapest. Revalidate selected availability/price at handoff.
- A summary and comparison derived from the same underlying result set; date/filter refinements update both. Sources stay inspectable.
- A real handoff preserving the permitted trip context and conversation, with the owning Travel application still enforcing its policy. Do not send private prompts or unrelated records through URL parameters.
- Separate authorization for reading/searching versus creating a fare watch, sharing a plan, writing calendar events or booking. No background watch starts merely because the user asks to find a cheap flight. Any checkout stays an explicit provider/user handoff.
- Server-enforced user/workspace isolation and revocation, not frontend filtering. Child/class/company presets constrain the same assistant through current capabilities and source scope, not just a different skin.
- Actual disposable multi-user HTTP/browser tests plus scoped installed/provider acceptance. Register production tests in the appropriate Test Lab catalogs; the mockup suite is not production acceptance.

The [reskin study](RESKIN-IMPACT-STUDY.md) estimates the shared presentation/configuration work. This central-assistant concept also needs a live orchestration/result contract and calendar/Travel integration assessment; do not assume the visual prototype establishes or budgets those backend capabilities.

## Files and verification

- `nexus.html`, `nexus.css`, `nexus.js`: standalone concept, local rendering and fixtures.
- `nexus-readback.js`, `nexus-readback-audio.js`: local playback controller and bundled sample; regenerate the audio with `build-readback-audio.ps1` on Windows with Microsoft David Desktop installed.
- `check-nexus.cjs`: executable browser checks and screenshot generation; run `node docs/assets/experience-shells/check-nexus.cjs`.
- `check-readback.cjs`: real Web Audio playback/analyser checks plus explicitly fault-injected decode, playback and missing-API cases; run `node docs/assets/experience-shells/check-readback.cjs`.
- `previews/nexus-*.png`: opening screen, assembled result, Travel view, and phone screenshots.

Final verification on 2026-09-25: **59 browser assertions passed**, covering timed progression, lowest-price/date exclusion consistency, text refinements, empty states, sorting, detail/shortlist, contextual Travel handoff, calendar, source disclosures, keyboard tabs, editable name/profile, escaped input, cancellation and six viewport widths (1440, 1024, 768, 600, 390, 320). Zero browser runtime errors or external HTTP requests. Desktop home/result and mobile home/result screenshots were visually inspected. The Homebase/gallery regression suite also passed its 202 assertions after the gallery addition.

No existing production source, provider configuration or backlog item was changed. These checks are prototype behavior evidence only. No production Test Lab or live calendar/provider acceptance is claimed.

Speaking-motion verification on 2026-09-25: **44 additional browser assertions passed**. Actual bundled PCM decoding/playback produced varying analyser energy and particle scatter; natural completion and Stop restored the resting core. Covered replay, cancelled decoding, workspace/new-chat cancellation, unsent-draft preservation, motion toggle during speech, OS reduced-motion changes, transcript layout at six widths, unsupported audio, and successful retry after temporary decode/playback failures. Only fault cases replace browser audio methods; the normal path uses real Web Audio. Zero runtime errors or external requests. The existing 59 central-assistant checks passed again. Desktop speaking and mobile transcript/result screenshots were inspected; the in-app preview visibly entered Speaking and returned to Readback complete. This does not certify speaker output on every device or a production speech integration.
