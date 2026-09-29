# AI Test Lab (ADR-063)

> Open work: [backlog/test-lab.md](./backlog/test-lab.md)

A black-box harness that answers two questions on demand or on a nightly schedule:

1. **Does each tool still work, and do the apps compose** into the real cross-app workflows a user
   would actually ask for? (the interactive Test Lab surface)
2. **Does the swarm still produce the right answers** to complicated requests — graded against a
   fixed expected output, with a morning report? (the nightly golden loop)

See [ADR-063](adr/063-ai-test-lab.md) for the decision record.

The synthetic phone/IVR harness is separate from this Lab's real-endpoint runner; see
[Synthetic phone-call simulator](testing/voice-call-simulator.md) for mock endpoints, traces,
scenarios, and its explicit no-real-call boundary.

---

## Part 1 — Interactive Test Lab (manual)

A surface that drives the **real** app endpoints with your session cookie forwarded, so every step
runs exactly as you would in the browser. Open it at **cockpit → Optimization → AI Test Lab**
(the sidebar's former "Cloud & Ops" group was split into Connections / Security / Optimization,
2026-07-07).

Three kinds of scenario:

- **Individual tools** — one-click smoke test per app (career, presentations, storage, calendar,
  Shop, travel, email).
- **Coupled multi-app workflows** — run as real chained steps; the lab is the orchestrator because
  Jarvis does not chain apps (it answers/dispatches one action per ask). Seeded:
  - *Job pack → deck → save → email* — top jobs → generate a resume → build a `.pptx` → save to
    storage → email a copy.
  - *Birthday + gift* — add the birthday to the calendar → find a Lego set → build the checkout
    handoff.
- **Jarvis routing** — fire each command at Jarvis and confirm it understands + dispatches.

Each step reports an honest state: **pass** / **degraded** (alive but needs a connected account,
fell back to demo/local, or async) / **gap** (capability missing — a finding) / **fail**.

### How to run it

1. Sign in to the cockpit (the runner uses *your* session, so results reflect your connections).
2. Open **AI Test Lab**, click **Run all** (or **Run** on one scenario).
3. Read the per-step badges; expand a card for the detail.

> "Run all" is synchronous and can take ~2 minutes (mostly Jarvis polling). It creates a few real,
> clearly-labelled rows (a calendar event, a generated deck). The `email me a copy` step needs the
> Google account you're signed in as to have the `gmail.send` scope (reconnect Google at
> /utilities once — the connector now requests it).

API: `GET /api/test-lab/catalog`, `POST /api/test-lab/run` (both `requiresAuth`).

### Artifact exchange and Jarvis registrations

The existing catalog includes **Artifact picker and tool metadata** (`artifact-discovery`, Tools)
and **Jarvis artifact target and confirmation** (`jarvis-artifact-handoff`, Jarvis). Each card's
**Regression suites** section identifies its unit, integration and browser test files. The paths
remain in the existing Vitest tree so the normal local test run continues to discover them.

The discovery scenario reads the active source/destination catalogs and validates the real YAML
tool load. The Jarvis scenario mints a short-lived handle over a Test Lab sample visual, checks the
actual model's named email target and ambiguous request in separate Lab chat sessions, and checks
that an unconfirmed email request returns 428. It never dispatches the proposed destination.
It creates Lab chat turns and consumes model usage when run; unavailable prerequisites remain
visible as degraded/gap rather than passing. Browser selection and replay behavior are covered by
the linked browser suites, not claimed by these server-side probes.

Run the associated isolated regression suites locally with `npm run test:artifacts`. Registration,
HTTP assertions and negative cases are themselves covered by
`tests/unit/test-lab-artifact-registration.spec.ts`. Registration in source does not claim that the
updated catalog or its live-model scenarios have already run on the deployed instance.

### Jarvis invariant preamble cache

The **Jarvis routing** card (`jarvis-routing`) also carries the guards for the invariant preamble
cache, the provider-side handle that stops every new conversation re-sending the system prompt and
tool declarations (as built in
[architecture/jarvis-own-task-recall.md](architecture/jarvis-own-task-recall.md)):
`tests/unit/invariant-prompt-cache.spec.ts`, `tests/unit/gemini-context-cache.spec.ts`,
`tests/unit/invariant-prompt-cache-protocol-seam.spec.ts` (integration: the real `openai` client
and `TaskController.processMessage` against a loopback Gemini surface) and
`tests/unit/invariant-prompt-cache-usage-accounting.spec.ts`. Run them with
`npx vitest run tests/unit/invariant-prompt-cache.spec.ts tests/unit/gemini-context-cache.spec.ts tests/unit/invariant-prompt-cache-protocol-seam.spec.ts tests/unit/invariant-prompt-cache-usage-accounting.spec.ts`.
The card's live steps run each Jarvis ask as before; they do not assert a cache hit, because the
installed before/after measurement is read from `chat_tasks` and the jarvis bot's call log, not
from the Lab.

### Jarvis answers that are a bare number or true/false

The same card carries the guards for an answer such as `5`, `3.14`, `true` or `false`. The text of
a completion is the literal result the model wrote, always a string, and the bot-node handler reads
a message text by its type. `tests/unit/antigravity-host-tool-loop.spec.ts` (integration) wires the
real handler to the real `TaskController` message path and agentic loop against the stand-in agy
child and asserts the delivered content; `tests/unit/completion-result-text.spec.ts` (unit) pins
the rule over the real parser. Run them with
`npx vitest run tests/unit/antigravity-host-tool-loop.spec.ts tests/unit/completion-result-text.spec.ts`.
The installed check is the `jarvis-cache` live acceptance case below, which asks for a bare number.

### Social signal subscriptions

**Social signals — your watches reach only your bot** (`social-signal-subscriptions`, Tools) runs
four steps over the signed-in caller's own `/api/content/subscriptions` routes:

- a watch naming a bot this swarm does not run is refused (`400 unknown_bot`) before anything is
  stored;
- the caller's watches are listed;
- the delivery audit of a subscription the caller does not own answers `404`;
- the caller's first watch returns its delivery audit (message id, bot lane, correlation id,
  claimed/published times). With no watch yet this step is degraded, not failed.

A passing run registers, publishes and disables nothing. If the bot refusal ever regresses, the
step disables the watch it accidentally created and reports fail. The card does not register a
watch or wait for the 15-minute poll, so it does not observe a live stream event.

Run the linked suites locally with `npm run test:social-signals`. The real-boundary suite
(`tests/unit/social-signal-subscriptions-postgres.spec.ts`) starts its own PostgreSQL and Redis.
Against the non-superuser enforcing role, under deny-by-default identity, it proves that one
subscription produces exactly one event on its owner's bot lane with a matching delivery audit
row, and that another user cannot read the subscription, the captured post, the delivery row or
the stream event. That is local evidence. Registration in source does not mean the card has run
on the deployed instance, and nothing here claims a live provider capture or a bot consuming the
lane.

### LinkedIn content queue

**LinkedIn content queue — ticket to confirmed publish** (`linkedin-content-queue`, Tools) runs
three read-only steps over the signed-in caller's own `/api/linkedin-assistant` routes:

- a publish without explicit confirmation answers `428`. It is probed on draft id 0, which a SERIAL key
  never issues, so even a regressed gate finds nothing to post;
- the caller's queue-created drafts name their source ticket and carry a citation list. Published
  ones are counted with the params hash that joins their connector audit rows. With no queue draft
  yet this step is degraded, not failed;
- an unknown draft id answers `404`, exactly as another owner's does.

A run drafts, approves and publishes nothing. Run the linked suites locally with
`npm run test:linkedin-content`. The real-boundary suite
(`tests/unit/linkedin-content-queue-postgres.spec.ts`) starts its own PostgreSQL and a local LinkedIn
protocol double. It takes one queue ticket through the real dispatcher to a confirmed publish on the
caller's brokered token, and proves the audit join, the ticket write-back and the denial paths. That is
local evidence. It does not show that a deployed Social package ran a ticket, or that a real LinkedIn
post was made.

### Congressional disclosure signal

**Congressional disclosure signal (STOCK Act)** (`congress-disclosures`, Tools) runs one read-only
step against the world series store: how many names carry an observed `quiver-congress` disclosure in
the last 90 days, the newest disclosure (ReportDate) day, and the newest `observed_at`. It makes no
write and no feed call. With world intelligence off it is degraded; with nothing observed yet it is
degraded and names the api log line to check; an unreachable store fails.

Run the linked suites locally with `npm run test:world-congress`. The real-boundary suite
(`tests/unit/world-metrics-observed-at-postgres.spec.ts`) starts its own TimescaleDB with
`world_metrics` in the pre-change shape (hypertable, legacy rows, the daily continuous aggregate) and
runs the real collector against a local feed server. It proves the ReportDate keying, the `observed_at`
column, that a second run appends nothing, and the bounded recent-disclosure read. The second
real-boundary suite (`tests/unit/world-depth-collectors-postgres.spec.ts`) fires the world depth
schedule through the real dispatch against its own TimescaleDB and a local feed server, holds the
subject sweep open, and proves the collector has already written observed rows before the first
subject starts; it also proves the ticker pulse never calls the flow collectors and that a collector
turned off by `WORLD_FLOW_ENABLED`, `WORLD_EVENTS_ENABLED` or `WORLD_GOV_ENABLED` is logged at WARN.
Its local feed also answers the default feed's 2026-09-28 reply (HTTP 401, "Authentication credentials
were not provided.") when the credential is absent: the fire must log "congress trades feed refused"
at ERROR naming `WORLD_POLITICAL_TOKEN`, write no row, and write once the token is set and sent as a
Bearer credential. That is local evidence; only a pass of the live step shows the installed collector ran.

### Token Chase checkpoint and tail replay

**Token Chase checkpoint and tail replay** (`token-chase-checkpoint-replay`, Tools) runs one read-only
step: the captured runs visible to the caller through `/api/token-chase/runs`. Degraded when nothing is
captured yet (capture is `TOKEN_CHASE_CAPTURE=true` on a bot node plus one agentic run) or the caller is
not signed in; gap when the route is missing. It never fires a replay: a tail replay restores a worktree
on a bot node and is an action, not a probe.

Run the linked suites locally with `npm run test:token-chase`. The real-boundary suites run the real
capture lane in a child process (private-git commits, per-turn pins, `final.json`), the real bot-node
route behind the real service-secret gate over a loopback server, the real file-tool handlers against an
isolated worktree, a real AES-256-GCM ciphertext store, and, end to end, the real `AgenticController`
loop over a scripted provider (`scripted-fixture`, explicitly identified). That is local evidence; the
replay on the deployed stack is the automated `token-chase-replay` case of the live acceptance sweep
below (`node scripts/operations/live-acceptance.js token-chase-replay`). A bot node registers the
read-only question tools and no file tool, so the live case restores, compares and stops on the node
and re-executes nothing there; a workspace tool re-executed by the tail is proven by these local
suites only. `tests/unit/live-acceptance-token-chase-replay.spec.ts` drives the live case against the
real bot-node registry, agentic loop, capture lane and tail executor.

### Market-data stream (ADR-143)

**Market-data stream (ADR-143)** (`market-data-stream`, Tools) runs one credential-free readback of
the kernel's own stream status: whether `TRADING_STREAM_ENABLED` is armed on this node, the venue
session state, the feed name, how many symbols are subscribed and the last print time. It opens no
socket and makes no venue call. Unarmed (the shipped default) is degraded and names the operator step;
an entitlement refusal fails; an authenticated session with a print passes, and the detail says it is a
print this node received, not the dated paper-ticket observation Phase 3 owes.

Run the linked suites locally with `npx vitest run tests/unit/trading-market-data-stream.spec.ts
tests/unit/compose-trading-stream-gate.spec.ts tests/unit/test-lab-market-stream-registration.spec.ts`.
The kernel suite is a real local protocol seam: a `ws` `WebSocketServer` on 127.0.0.1 speaks the venue
frame shape and records auth, subscribe, reconnect and unsubscribe messages, a live unarmed venue must
record zero connections, and the module's pino child logger is captured through a real pino sink and
read for the spec-set key and secret. The compose suite is a static default-off pin. That is local
evidence; the venue session, the operator arming and the regular-hours print/reconnect receipt are
outside every suite here (`docs/adr/143-market-data-stream.md`, Phase 3).

### Jarvis cross-conversation recall (live acceptance)

**Jarvis recalls another conversation** (`jarvis-cross-thread-recall`, Jarvis) is explicit-only: it runs
from its own card and never from "Run live scenarios", because it spends one real model turn on the
caller's configured brain. It seeds one owner-bound thread (`testlab-recall-a-<uuid>`) through the real
task and message stores, holding a random `TESTLAB-RECALL-<8 hex>` codeword, then asks Jarvis for that
codeword from a new thread (`testlab-recall-b-<uuid>`) through the real `POST /api/jarvis/ask`, naming
only the other thread's title. It passes only when the codeword is written into the new thread, read
through the caller's own `/api/jarvis/history`, within `deliveryBudgetMs` (300 s by default; an answer
that lands after Jarvis's 75 s decision window counts) and thread A still holds only its seeded
messages, AND the Token Chase
capture of that ask, read through the caller's own `/api/token-chase/runs/<thread>` routes, shows
`conversation_query` and/or `conversation_fetch` ran successfully in frames stamped for the caller. No
capture on the deployment is degraded, not green. Both threads, their messages, the chat ticket, the ask
job and the ask's workspace are then deleted, and a residue read over the owner's own row policies must
come back empty; anything left is red.

The same case (`scripts/lib/jarvis-recall-acceptance.js`) runs against a deployed box as the operator
automation identity, including an image that predates the card:
`node scripts/operations/jarvis-recall-live-proof.js` (reads `OSHAL_VERIFY_OPERATOR_PAT` by name from
the environment or `.env`, stages itself into the api container and forwards the token by name only;
`OSHAL_RECALL_DELIVERY_BUDGET_MS` overrides the delivery budget).
Suites: `npx vitest run tests/unit/jarvis-recall-acceptance.spec.ts
tests/unit/jarvis-recall-acceptance-postgres.spec.ts tests/unit/test-lab-jarvis-recall-registration.spec.ts`.
The PostgreSQL suite is the real boundary: the seed goes through the real stores as the app role, and
the real recall tools running as the bot role find it for its owner and nothing for another owner.
On the Antigravity brain the card also leans on `tests/unit/antigravity-host-tool-loop.spec.ts` and
`tests/unit/antigravity-bot-runtime.spec.ts` (attached here and to `jarvis-routing`): the same two-tool
recall through the real host loop with agy holding no native tools, and the invocation's permission scope.

### LoRA gallery import (live acceptance)

`node scripts/operations/lora-import-live-proof.js` (`lora-gallery-dataset-import`) proves the
Send-to → Add to LoRA dataset path on a box with the LoRA package and a GPU worker online, in two
modes. Both create a synthetic `testlab-import-<hex>` character as the operator PAT, wait for the
receipt the studio shows as "ready on worker", then read the character's `curated/` folder on the
worker through the remote-client `shell.exec` rail with a read-only probe (the path training reads,
plus the single-quoted literal path as a diagnostic).

- **Inline mode** (no flag; runs inside the api container): mints a Send-to handle carrying one
  generated PNG (`POST /api/artifacts/handles/upload`) and imports it by `POST /api/lora/dataset/import`.
- **Gallery mode** (`--gallery`; runs on the host, where the browser is): the real gallery and the
  rendered surface. It creates one synthetic portrait through `POST /api/portrait-studio/portraits`
  (a flat synthetic photo, the catalog's first professional style), titles it with the fixture tag,
  waits for the engine to mark it `done`, mints the locator handle exactly as the gallery's Send to…
  does (`POST /api/artifacts/handles` with `source: /api/portrait-studio/portraits/<id>/image`), opens
  `/api/lora/ui?artifact=<ref>` in a headless Chromium as the caller (the token rides only on
  same-origin requests; every other request is aborted in the browser), clicks the fixture character
  and "Import selected image", and reads `#datasetRows` until the studio itself shows the file "ready
  on worker". A run whose receipt route says ready while the surface does not is red, and so is a page
  error. It spends one real portrait generation (the engine's model and cost land in the evidence),
  and it is UNAVAILABLE by name when the PAT, the LoRA or Portrait Studio package, the image engine,
  or a GPU worker is missing (an offline worker is named). Knobs: `OSHAL_VERIFY_BASE_URL`,
  `OSHAL_LORA_PORTRAIT_BUDGET_MS`.

Cleanup in both modes removes the box directory, the import ticket (through the ticket service after
re-reading it), the portrait (gallery mode, after it revalidates by its title tag) and the character,
whose receipt, staged bytes and grants cascade; the database steps run as the owner through the
live-acceptance container helper's named statements (`lora.*`). It is a core script rather than a
package `tests/test-lab.yaml` case because it orchestrates core artifact exchange, the core
remote-client rail and the store package on a real worker, and the package catalog leaves live
external-write cases pending. Suites: `npx vitest run tests/unit/lora-import-live-proof.spec.ts`
(inline mode; on win32 the box probe and removal commands also run through real `powershell.exe`
against a temp home; other hosts print one PLATFORM SKIP line) and
`npx vitest run tests/unit/lora-import-gallery-proof.spec.ts` (gallery mode; its surface port runs in
real headless Chromium against a loopback stand-in of the studio page - a surface that renders the
receipt ready passes, one that keeps rendering "queued for worker" fails by name, and an off-origin
request from the page never reaches a second loopback listener). An unreadable probe
is named in the verdict: which field is wrong, the probe task's exit, and the first 300 redacted
characters of the worker's stdout.

### Automated live acceptance sweep

`node scripts/operations/live-acceptance.js <case|all|list> [--record-doc] [--allow-paid]` runs the automated live
acceptance cases for merged work that was never proven on an installed box. It runs as the operator
automation identity (`OSHAL_VERIFY_OPERATOR_PAT`, read by name from the environment or the box's
`.env`, never printed and never put on a command line), against `OSHAL_VERIFY_BASE_URL` (default
`http://127.0.0.1:35457`), and needs no deploy: it drives whatever is installed. When
`OSHAL_VERIFY_SECOND_PAT` is also present (the same two sources, read the same way), the cases get a
`second` port that acts as that token's owner and never sends the operator token; without it no such
port is bound and a leg that needs one reports itself unavailable by that name. It prints one
`PASS` / `FAIL` / `DEGRADED` / `UNAVAILABLE` line per case, the case's cleanup receipt (what was
removed, what was deliberately kept and why, anything outstanding, every cleanup error) and its
evidence, then one summary line. It exits 0 only when every selected case passed. Every fixture is
tagged `testlab-live-<case>-<8 hex>` (the commerce and watchlist fixtures use the page's own shapes)
and removed; a cleanup miss turns the case red.

| Key | Card | What it proves on the installed build |
|---|---|---|
| `create-region-edit` | `live-acceptance-create-region-edit` | One API-driven cycle on a tagged project with an image and an editable text layer. Upload a generated 512 x 384 PNG as the single `image` multipart part and read its decoded pixels back unchanged; request a 192 x 192 unfeathered box edit against revision 1; require at least one changed inside pixel and byte-identical RGBA outside the box. The accept response must be revision 2 with only the image replaced and the text layer unchanged; the current project must read back at revision 2 with the same document as the accept response, and revision 1 must still match the saved document. Delete only the tagged project and require both project and edit reads to return 404. Uploaded images are deliberately retained for Create's later cleanup. A provider reported paid at preflight requires the host command's explicit `--allow-paid`; the Lab card reports a gap instead. See the limitations and outstanding verification below. |
| `response-renderer` | `live-acceptance-response-renderer` | The `shared-response-renderer` card passes all three steps, Mermaid is served same-origin from `/dist/vendor/mermaid` (exact `VERSION`, JavaScript entry, no redirect), and the Little Monsters `tutor-shared-renderer` package case runs through the durable run route and executes tests (a run that declines is not a pass). After an api start the catalog lists browser cases as not runnable with "The playwright runner is unavailable." until the api's lazy runner probe finishes, and the listing that begins the probe still answers that. While that is the Tutor case's reason the case re-reads the catalog every 3 s, for up to 165 s (the probe's own timeout is 150 s), and runs what the last read lists. Any other reason, or that reason still present when the wait ends, is `DEGRADED` with the reason. |
| `congress` | `live-acceptance-congress` | The `congress-disclosures` readback passes, `GET /api/trading/reports/congress` lists rows that each carry a ReportDate day and `observedAt`, and the watchlist Add step adds a synthetic `ZZT-XXXXX` ticker (symbol only, as the Add button posts it) and deletes it. |
| `dev-workspace` | `live-acceptance-dev-workspace` | In dev mode, four Jarvis package-tool asks in one tagged Jarvis conversation (which the proposals must belong to) each return a cited `doc_id` of their path family: ADR-077 by number (`docs/adr/077-*`), a `docs/BACKLOG.md` entry title, a runbook (`docs/runbooks/*.md`, not the README) and tonight's handover (`local-notes/*`, from the index's `--notes-dir`). A family result without a `doc_id` fails. With dev mode off all four are refused with no citation; an unauthenticated `GET /api/dev-workspace-index/query?q=ADR-077` answers 401 or 403; dev mode is left as found. The backlog and runbook words have tracked defaults (`OSHAL_VERIFY_DEV_BACKLOG_PROBE` / `OSHAL_VERIFY_DEV_RUNBOOK_PROBE` override them); the handover words have none. They come only from `OSHAL_VERIFY_DEV_NOTES_PROBE` in the host runner's environment: `OSHAL_VERIFY_DEV_NOTES_PROBE="<its words>" node scripts/operations/live-acceptance.js dev-workspace`. Unavailable, never pass, when those words are missing (the gap names that command) or the index holds no `local-notes` documents (the `--notes-dir` build step is named). Compose forwards no `OSHAL_VERIFY_*` variable to the api, so the Lab card has no source for the handover words. It reads the gate and the index sources, puts dev mode back, and reports the handover ask as a host-runner gap before any model turn. It never passes. A closed gate (package, `OSHAL_DEV_WORKSPACE_INDEX_ENABLED`, `OSHAL_DEV_CONSOLE_ENABLED`, `OSHAL_SUPERADMIN_SUBS`, index not built) is reported by name; those need an api restart, so the case never opens them. Spends one model turn (host runner). |
| `floater` | `live-acceptance-floater` | The ADR-160 Floater, seeded through aero-lab's own route, shows evaluation 1's mass budget RED at +274.3 g and the fabricable sentence verbatim. An owner's existing Floater is only read; a Floater the case seeded is deleted (the package has no delete route, so through the closed statement set under the owner's identity) and proven gone. |
| `linkedin` | `live-acceptance-linkedin` | A tagged synthetic `linkedin-content-post` ticket becomes a graded pending-approval draft that names the ticket and carries its citation, and publishing it without confirmation is refused 428. The case never approves, confirms or publishes; the draft is rejected and deleted and the ticket removed. Spends real model turns. |
| `commerce` | `live-acceptance-commerce` | Rides, Eats and Shopping at 390 x 844 in headless Chromium: the page fits, its own flow reaches something to confirm, the relayed outward op renders the confirm card, and Cancel hands off nothing. Every hand-off POST is aborted in the browser and `window.open` is stubbed, so a regressed gate is counted and reaches nothing. Shopping is walked whatever the caller's cart holds. The add the page posts is stamped in the browser with the run's tag (`testlab-live-commerce-<8 hex>`, in the line's `reason`), the line the add answered must carry that tag and be shown by the page before the confirm card is raised, and cleanup sends `DELETE /api/purchasing/lists/<list>/items/<line>` only for lines that were absent from the cart before the run and carry the tag or the answered id. A line the cart already held is never sent a removal; each is read back and compared field by field, and one that is missing or differs turns the case red, naming the line and the fields and no values. A line that appeared during the run and is not the case's is left and named in the receipt. Eats is walked only with an empty cart; with lines in it that surface is skipped and the case is degraded. Host runner only. |
| `lm-class-material` | `live-acceptance-lm-class-material` | One tagged class, two legs. Handle leg: a generated PDF carried in a Send-to handle (`POST /api/artifacts/handles/upload`) and `POST /api/education/import-artifact` answer 201 approved with the material in the class's shared materials. Files leg (entry #19's Done-when as written; host runner only): a second generated PDF goes into the caller's oshal storage through `POST /api/files/upload?provider=oshal-local`, headless Chromium at desktop width opens `/api/files/`, presses the file's Send to… chip and picks "File into a class"; the mint must be the files browser's own locator over `/api/files/download` (a carried-bytes handle fails the leg), the shell must land on `/cockpit/?app=little-monsters&artifact=<ref>&artifactAction=class-material`, the Little Monsters picker must offer the tagged class, and the import the destination page posts must carry exactly the class chosen there and answer 201 approved and listed. From the Lab (no Chromium) the files leg is a named gap and the card is degraded, never pass. Optional non-teacher leg: only when the runner binds a second caller (the host runner does when `OSHAL_VERIFY_SECOND_PAT` holds another caller's token, a Little Monsters student's). The class is minted by the run, so nobody but its creator is in it: the case enrolls the second caller itself through the class bank (`POST /api/education/classes/:classId/enroll`), requires `GET /api/education/classes` to offer that caller the class, and files a third generated PDF as that caller. That import must come back `requested`, stay out of the shared materials and appear in the teacher's share requests. The leg is unavailable by name when no second caller is bound (always from the Lab, which has one signed-in principal), when the enroll is refused (4xx: the caller holds no Little Monsters grant in the operator's school, or the token is not valid) and when the second token is the operator's own; an unavailable leg does not decide the verdict. An enroll that answers 201 without taking, or a 5xx, fails the leg. Cleanup deletes every material through its owner, takes the second caller out of the class (`POST /api/education/classes/:classId/leave`, with the class bank read back as that caller), deletes the class, and removes the storage file through `DELETE /api/files?provider=oshal-local` with the folder read back. |
| `trading-parity` | `live-acceptance-trading-parity` | The `trading-parity-features` card passes all three steps (market gap, exit plans and yield sleeve, each armed on the paper book; a degraded step is reported as not runnable with the setting it names), `GET /api/trading/position-plans` answers the paper book's plans and plan arm, and both promotion paths (plan amend, a parity mix edit) answer 428 to a change sent without confirm. Read-only: nothing it sends carries confirm. |
| `jarvis-cache` | `live-acceptance-jarvis-cache` | Three fresh tagged Jarvis conversations: the Jarvis bot's `OpenAI-compatible call` line shows the invariant cache created, then hit with cached tokens. `--record-doc` writes the table into `docs/architecture/jarvis-own-task-recall.md`. When no OpenAI-compatible call is logged the case names the brain that answered instead. Host runner only (`docker logs`). Spends three model turns. |
| `vids-publish` | `live-acceptance-vids-publish` | Through the real package loader mounts (`/api/vids` under `service-or-oidc`, `/api/vids-public` under `public`): one tagged finished Vids job for the caller (the closed statement set; no route can make a job `done` without a Vids worker) with a real one-frame MP4 carrying the run tag attached through `POST /api/vids/jobs/<id>/artifact`. An unauthenticated `GET /api/vids/jobs` and an unauthenticated confirmed publish of that job must each answer the mount gate's own 401 (`authenticated: false`, `unauthorized`; a 401 from the package's in-router guard means the mount lost its gate and fails), and nothing may become public. The owner's confirmed publish with the reviewed digest yields a link whose anonymous read returns exactly the uploaded bytes as `video/mp4`; a malformed token answers 404; after the owner revokes, the same read answers 404. Cleanup revokes if needed, removes the export through the package's `DELETE` route, proves its MP4 gone from disk with the named `vids.export` file probe (which must first have seen it present), deletes exactly the tagged job and reads the residue back as zero; an MP4 left on disk is red. Unavailable, never pass, without vids 1.5.0 or later. |
| `token-chase-replay` | `live-acceptance-token-chase-replay` | Through `POST /api/token-chase/runs/<id>/tail-replay`, which the controller delegates to the bot node that produced the run. A bot node registers only the read-only question tools (`rag_query`, `graph_query`, `conversation_query`, `conversation_fetch`), and each is a live read, so both legs use a question-tool run: every tool result it consumed came from those tools, at least one call succeeded, and its final checkpoint is completed. The case takes the newest such captured run of the caller, or starts one tagged turn on `oshal-assistant` through `POST /api/tasks/<tag>/messages` that asks for one `conversation_query` call, waits for its capture to close, and removes it afterwards (chat task and messages, ticket if any, ask workspace, residue read as zero). Reproduced leg: the no-edit tail from the first frame answers `stopped`, restored the checkpoint of that frame with `restore.integrity` `ok`, reports `artifacts.reproduced` true with no differing path and `replayTreeSha` equal to `final.checkpoint.treeSha` read independently through `GET /api/token-chase/runs/<id>/final`, re-executed 0 tool calls and made 0 paid calls. It proves the restore and the comparison on the node. It does not prove a workspace tool re-executed there, because no bot-node run holds one; that re-execution is local evidence (`npm run test:token-chase`). Live-read leg, on the same run: the tail stops at the frame that called the tool with status `live-tool` after every earlier frame `reproduced`, and replayed from the consuming frame answers `non-replayable`. `--expect-store-bound` (host runner) also requires a store-bound run and `storeVersion {bound: true, reproduced: true}`; the deploy lane runs it after `TOKEN_CHASE_OWNER_STORE_SNAPSHOT=on` on one bot. A leg with no usable run is unavailable, never pass, and names what the run shows: the tools its node offered the model when `conversation_query` was not among them (the node resolved no executable grant of it for that bot; `OSHAL_VERIFY_TOKEN_CHASE_AGENT="<bot name>" node scripts/operations/live-acceptance.js token-chase-replay` names a bot that runs on its own node and holds one), a call that failed, a model that finished without calling the tool, a capture that never closed (`TOKEN_CHASE_CAPTURE` on a bot node), or a run that is not store-bound. A producing bot with no reachable node is unavailable naming the bot. Spends at most one model turn (only when it starts a run). |

The same case modules (`scripts/lib/live-acceptance-*.js`, listed in `live-acceptance-cases.js`) run
from the Lab as explicit-only cards (never from "Run live scenarios"), bound to the signed-in caller;
the commerce and Jarvis-cache cards report a gap there, because Chromium and the call log exist only
on the host. The dev-workspace card reports its handover ask as a gap there too. Its words
(`OSHAL_VERIFY_DEV_NOTES_PROBE`) exist only in the host runner's environment, and the Lab passes its
cases an empty runner environment instead of the api's. On the host, the owner-scoped statements, ticket reads and ask-workspace removal run
through `scripts/lib/live-acceptance-container.js`, staged once into the api container per run.
Suites: `npm run test:live-acceptance`.

#### Create region-edit: prerequisites, consent and evidence

Run `node scripts/operations/live-acceptance.js create-region-edit` only against an operator-approved
installed target. It needs Create's region-edit routes with `costConsentVersion: 1` in the provider
report (region editing first appeared in 1.9.0), a configured image provider,
and the caller's `project.view`, `read`, `create`, `change`, `delete` and `generate` permissions.
Permission and provider reports are read before any fixture write. Missing installation, grants or
provider configuration or the exact consent-contract version are unavailable, not a pass; upload quota, an existing in-flight edit and the
daily edit limit are also named gaps. This case does not start or install any service.

If preflight reports a paid provider, the explicit host command is
`node scripts/operations/live-acceptance.js create-region-edit --allow-paid`. It can make one real
image-generation request and incur a charge, including on a failed or cancelled run. The Lab never
sets `allowPaid`. Every generation body carries `maxCostClass`: `paid` only when both the explicit
flag and a paid preflight are present, otherwise `free` (even with the flag on a free preflight).
The server captures this cap per job and checks the actual provider after queueing, immediately
before generation, refusing an unknown class or paid provider under a free cap with
`region_edit_cost_cap_exceeded` and zero generation calls. There must be no unchecked fallback.
This is a cost-class cap, not a dollar cap or a specific-provider pin. Legacy callers may omit the
optional server field; this driver never does. Servers without the exact advertised contract are
refused before uploads or project writes; another client-side preflight is not a substitute.

Possible admission is tracked before the generation POST is sent. A rejected connection or a 202
without a usable edit ID retains the tagged project with a red cleanup receipt; it is not retried
or treated as proof that no generation started. Only explicit in-flight/daily-limit refusal replies
establish non-admission. Otherwise deletion requires a matching terminal record with a candidate ID
when applicable and well-shaped reported spend metadata (a nonnegative finite amount or the
contract's explicit null, never an inferred zero). This check applies to ordinary ready replies as
well as cancellation. A malformed candidate does not discard valid spend evidence, nor malformed
spend a known candidate ID. If cancellation loses to completion, its terminal record is read before
deletion; a successful cancellation must itself affirm the matching cancelled record. Unresolved
outcomes retain the project and any known edit as outstanding, with a red receipt. Create has no per-asset delete route: its source and candidate
uploads remain eligible for owner-scoped cleanup after 24 hours; a late candidate can remain too.
The case never invokes owner-wide asset cleanup or removes accounting records. Provider, model and
cost in its evidence come from the edit response, not an independent read of the canonical ledger.
Acceptance compares original layer order and every document property outside images/layers, not
just layer IDs. The PNG reader explicitly refuses `tRNS` transparency rather than inventing opaque
alpha. This is one API cycle proving mask/document preservation, not browser acceptance, two-cycle
manual-edit/undo coverage, another owner's isolation, or instruction fidelity.

Earlier verification (2026-09-29, before independent-review corrections): the focused region case
(19), host runner (20) and Lab registration (7) guards passed serially with one worker, including real loopback HTTP/multer transport guards.
Removing the persisted-document comparison caused three expected failures; removing early
cancellation tracking caused four. Both fixes were restored and the region guard passed again.
After the independent-review corrections, the region suite passed **37/37** and the final Lab
registration suite **7/7**, each alone with 128 MiB runner / 384 MiB worker heap caps. A combined
targeted mutation produced 16 expected failures (2 transparency, 5 unsupported consent versions,
1 wrong class cap, 3 cancellation-race/provenance, 5 layer-order/document changes); restoring every
safeguard returned the region suite to 37/37. The server cost-cap companion is handled separately;
its compiled-route receipts below are separate from this driver's doubled-body guards.

Current frozen revision (2026-09-29): the coordinating parent reports **73/73 tests across 3 files**
passed for the region case, host runner and Lab registration, exit 0 in 35.32 s. The run started
at 12:51:21 America/Chicago with 2084 MiB free at preflight, using one fork worker capped at
384 MiB and a 128 MiB runner. No provider execution occurred. This run includes the latest
admission-uncertainty/ordinary-terminal cleanup regressions. Independent source review approved
the exact frozen implementation and tests with unchanged hashes. Subsequent minimal cleanup
mutations caused exactly 2 expected failures when pre-POST admission tracking was removed and
6 when ordinary terminal accounting was marked complete before validation. Each mutation was
restored to the approved source hash. The nine new cleanup guards passed before and after those
mutations; the full three-file focused set then passed **73/73** again in 24.04 s, exit 0, with
no failures or skips, using the same 128 MiB runner / one 384 MiB fork limits. No test was edited.
The parent also reports both full core typechecks passed: `tsconfig.json` and
`tsconfig.server.json`, with outer exit 0 via file-redirected stdin. The locked compiler ran in a
3 GiB container with `--noEmit --preserveSymlinks`, against the exact HEAD source archive plus
the sole dirty TypeScript overlay for Lab scenarios. Implementation and tests remain unchanged.
The parent reports actual compiled Create companions passed sequentially: API **7/7** (1.30 s),
real PostgreSQL **22/22** (9.25 s), and real browser **6/6** (22.61 s), zero failures/skips. These
use a synthetic provider, not an installed image provider. Each PostgreSQL fixture reported
`cleanupVerified: true`; separate final fixture-inventory verification remains with the parent.
Commit/push hooks are separate gates; these receipts do not imply they have run.
No installed run or canonical accounting proof is claimed. See the
[Create region-edit boundary audit](governance/real-boundary-regression-audit.md#create-region-edit-live-acceptance-2026-09-29)
for the fixture boundaries and remaining evidence.

### Messaging channels

**Messaging channels — what can reach your swarm** (`channel-inbound-bindings`, Tools) reads the
caller's own `GET /api/channels` and fails unless the surface reports a wired/not-wired state for
Telegram, SMS, WhatsApp and Discord plus the caller's linked identities. It is read-only.

**Messaging channels — one message in, one answer out, strangers refused**
(`channel-inbound-round-trip`, Tools) has one step per provider (Telegram, Discord, SMS, WhatsApp).
Each step runs as the signed-in caller through the real identity store, the provider's real inbound
processor and the real refusal ledger. It mints a code, links a lab-prefixed synthetic identity (a
fictional 555-01xx number for SMS and WhatsApp), sends one message twice with the same occurrence
id, and sends one from a never-linked identity. It passes only when exactly one bot turn ran for the
caller under the caller's non-operator identity carrying the caller's verified issuer, the answer came back, the duplicate was refused, and
the stranger was refused with a committed refusal-ledger row. The bot turn and the provider send are
doubled, so a run spends nothing and messages no real account. The lab link is removed afterwards;
the occurrence claims and the refusal row stay as permanent receipts (the runtime role can only
insert them). Without a signed-in caller and the app database each step is degraded.

**Messaging channels — is the Discord bot set up and connected** (`channel-operator-setup`, Tools)
reads `GET /api/channels/admin/discord` as the caller. The route is operator-only, so a non-operator
and a missing session degrade rather than fail. For an operator it passes when no bot is configured
(naming the cockpit card that enables one) or when the bot is configured and the Gateway is
connected, and fails with the exact fix when the state names a problem: Discord rejected the saved
token, or the Message Content intent is off in the Developer Portal. It is read-only.

Run the linked suites locally with `npm run test:channels`. The real-boundary suites
(`tests/unit/chat-channel-inbound-postgres.spec.ts`, `tests/unit/chat-channel-denial-audit.spec.ts`,
`tests/unit/chat-channel-principal-issuer.spec.ts`, `tests/unit/sms-inbound-dispatch.spec.ts`,
`tests/unit/chat-channel-admin-postgres.spec.ts`) start their own PostgreSQL. The admin suite also
runs a local HTTP server speaking Discord's identity reads and a local Gateway, and
`tests/unit/chat-channel-setup-card-browser.spec.ts` drives the cockpit card in headless Chromium. The principal-issuer suite sends each linked message through the real
controller delegation client and verifies the signed token names the owner and the issuer. Against the non-superuser
enforcing role under forced RLS they drive the real Telegram webhook over HTTP, the real Discord
Gateway client over a local WebSocket server, and the real signed Twilio webhook for SMS and
WhatsApp. That is local evidence: registration in source does not mean the card has run on the
deployed instance, and nothing here is a real Telegram, Discord or WhatsApp message.

### Shared response renderer

**Shared response renderer: one untrusted reply, every surface** (`shared-response-renderer`,
Jarvis) has three read-only steps:

- the running server serves `/dist/response-renderer.js` and it publishes
  `DISPLAY_ONLY_RESPONSE_CAPABILITIES`. Jarvis and the swarm-bot chat refuse a bundle without it
  and stay on escaped text, so a missing or older bundle is reported as a deployment gap;
- the same-origin Mermaid runtime is served from `/dist/vendor/mermaid` at an exact version
  (a gap when the image predates the vendoring);
- the renderer's own conformance reply, `SHARED_UNTRUSTED_RESPONSE` (remote gallery image,
  arbitrary download link, forged `oshal:provider-record` and `artifact:image` fences), rendered in
  the server process through that profile produces no image, link or URL-bearing attribute and
  exactly its expected block sequence: the gallery and download stay visible escaped fallbacks and
  no forged fence parses as a trusted block.

Run the linked suites locally with `npm run test:response-renderer`. The Chromium suite
(`tests/unit/shared-response-surfaces-browser.spec.ts`) loads the unmodified `jarvis.html` and the
real chat bubble module, bundles the renderer from source and vendors Mermaid with the build's own
step. It proves that the same conformance reply renders to the identical block sequence on both
surfaces, that nothing requests the hostile host or any CDN, and that the diagram hydrates
same-origin or stays readable text when the runtime is missing. The Little Monsters Tutor runs the
same vector in the store (`little-monsters/tests/tutor-renderer.core.spec.mjs`).

The card also carries the JVV-003 delayed-work suite
(`tests/unit/jarvis-queue-lifecycle.integration.spec.ts`). A Jarvis hand-off files a real approved
ticket, and one real queue poll dispatches it through the real `BotNodeClient` over loopback HTTP.
The dispatcher then writes the completion to the message store and closes the ticket, and Jarvis
summarizes that completion once, persists one immutable visual and returns it to the original
Discussion. No test code writes the terminal ticket state.

Real code in the chain: the Jarvis routes, `TicketService`, the queue poll and manifest-worker
dispatch, the orchestration code of the ADR-083 call-out resolver, and the `BotNodeClient` HTTP
client. Everything else is a double:

- **Routing decision.** `agentRouter.route` is fixed to return the one worker with strategy `bid`.
  The resolver's inputs are stubs too: the mesh bid transport, `agentProfileRepository`,
  `resolveOnlineAgentIds` and `isAgentAccessibleTo`.
- **Worker.** A canned loopback `node:http` handler for `POST /api/swarm-execute` returns a fixed
  deliverable. It is not `bot-node-server`.
- **Stores.** The completion goes to an in-memory `vi.fn` message store, not Postgres. Tickets and
  tasks use the in-memory stores, and the Jarvis SQL rows are the in-memory `DelayedLifecyclePool`.
  The database module's pool, bootstrap and RLS helpers are mocked.
- **Runtime and helpers.** The swarm runtime, the chat orchestrator and `resolveAgentIdByName` are
  stubs. The hosted model (`executeBotOrInline`), `connector-token-broker`, `free-tier-rotation` and
  `user-model` are `vi.mock`ed.
- **Identity.** A header middleware stands in for OIDC, and `applicationAuthorization` is a stub.

All of this is local evidence. Registration in source does not mean the card has run on the deployed
instance.

### Location log safety (ADR-169 L1)

**Location — logs never carry a position (ADR-169 L1)** (`location-log-safety`, Tools) runs two
credential-free steps inside the server process, on the build that is running:

- `log-redaction`: the shipped pino redact list holds the namespaced keys `location`, `*.location`,
  `coords` and `*.coords`, a synthetic fix logged under them (top level and one level down) never
  reaches the serialised line, and `locationSafeError` reduces an error whose message carries a
  provider URL with coordinates to its class name, code and scrubbed stack frames;
- `geo-canary`: the shared geo maths in `src/shared/utils/geo.ts` answers six synthetic checks
  (haversine, containment either side of a 100 m edge, `block` rounding, `place-only`, a distance band).

Neither step reads, stores or logs anyone's location. The control ADR-169 D3 names for everything
deeper than one redact level, the static log guard over `src/features/location` and the location
routes, runs in the unit suite: `tests/unit/location-log-guard.spec.ts` derives its scope from the
tree (slice files, `location*` paths under `src/app`, `/api/location` declarations in
`src/app/routes`, and the router behind every `/api/location` mount) and admits a logger call only
with allowlisted id, count and literal-label fields and `err: locationSafeError(error)`.

Run the linked suites locally with `npm run test:location`. That is local evidence; registration
in source does not mean the card has run on the deployed instance.

### Location storage with no operator bypass (ADR-169 L2)

**Location — storage has no operator bypass (ADR-169 L2)** (`location-storage-rls`, Tools) runs two
steps against the database the running build uses:

- `rls-posture` reads only the catalog. Every location table must exist with ENABLE and FORCE and at
  least one policy. No policy, and no function a policy reaches, may mention `oshal.is_operator`
  (operator decision Q2). The membership fence, the creator fence and `oshal_is_tenant_admin` must be
  installed. A connecting role that bypasses row-level security grades as a gap, not a pass.
- `two-identity-probe` runs in one transaction that is always rolled back. A synthetic owner writes a
  fix. A synthetic stranger, the same stranger operator-stamped, and the SYSTEM stamp each read none
  of it. An operator-stamped session cannot add itself to a synthetic group. The owner then purges
  the fix.

Nothing persists, and no real person's row is read. The linked suites prove the same rules on a private
PostgreSQL as the enforcing runtime role:

- `tests/unit/location-storage-rls-postgres.spec.ts`: owner and stranger, member and admin, the
  membership fence, SYSTEM, the purge, member and guardian shares, and restrictions.
- `tests/unit/location-erasure-routes-postgres.spec.ts`: both account-erasure routes.
- `tests/unit/location-rls-no-operator-guard.spec.ts`: the static guard over `scripts/migrations`.

Run them with `npm run test:location` (Docker is required for the PostgreSQL suites). That is local
evidence. After a deploy, run the card from the Test Lab to check the deployed database.

### Location browser ingest, consent and the step-up (ADR-169 L3)

**Location — browser ingest, consent and the step-up (ADR-169 L3)** (`location-browser-consent`, Tools)
runs three steps on the build that is running:

- `service-rail-refused` posts to `/api/location/presence` over the loopback with the service secret
  (the configured one when set; it is never printed) and expects 401.
- `step-up-gate` runs as the signed-in person. Opting in and accepting a share are each refused
  without a fresh sign-in, including with a challenge the Lab opened but did not prove. Arming a rule
  has no route to reach. The person's devices and shares must not change, and the Lab must withdraw its
  challenge; a failed or refused withdrawal fails the step.
- `consent-lifecycle` runs the consent and ingest services the routes call, for a uniquely tagged
  synthetic person on the real database. It opts a browser in and posts a fix whose body names another
  owner. The fix must be stored for the synthetic person at `block` precision and placed in their
  synthetic place. Opting out must clear the current place and keep the history, and further fixes are
  refused. The purge removes the history, and an erase must leave no row of the synthetic person.
  Incomplete cleanup fails the step.

No real person's location is read or written. The linked suites:

- `tests/unit/location-settings-browser.spec.ts`: the Settings, Location page in Chromium on localhost
  with `MOCK_OIDC`. It opts a browser in through the sign-in-again window, shows the current place,
  opts out (the history stays and ingest stops) and purges. Script on a same-origin packaged surface
  cannot opt in, raise precision, accept a share or arm a rule.
- `tests/unit/location-browser-consent-postgres.spec.ts`: a body-supplied owner is ignored, the service
  secret is refused, and proofs are single use and bound to their parameters and person.
- `tests/unit/location-oidc-step-up-browser.spec.ts`: real OIDC against a local identity provider.
  `max_age=0` is sent, and a stale `auth_time`, a skipped round trip or a different account prove nothing.
- `tests/unit/location-step-up-totp-postgres.spec.ts`: a local-auth session proves it with a second-factor
  code. Once a person has spent their failed-code budget, every fresh challenge gets 429 and even the
  right code is not checked.
- `tests/unit/location-step-up.spec.ts` and `tests/unit/location-route-policy.spec.ts`: the proof store
  and the declared step-up rule of every `/api/location` route.

Run them with `npm run test:location`. That is local evidence. After a deploy, run the card from the
Test Lab.

### Location places and devices at places (ADR-169 L4)

**Location — places and devices at places (ADR-169 L4)** (`location-places-devices`, Tools) runs two
steps on the build that is running:

- `place-routes` runs as the signed-in person. The places and devices lists must carry no coordinate and
  no address. A camera with no group, a node the person does not own, and a place for a group they do not
  administer are each refused, and the person's places and devices must not change.
- `places-lifecycle` runs the place, enrolment and kernel-read services for three uniquely tagged
  synthetic people on the real database. An admin makes a group with a member, a place of their own and a
  group place, records a synthetic node binding of their own, enrols that node, a camera (to the group) and
  a TV with places, and moves the TV. The member must not be able to change the camera or find the node,
  and the stranger must not find the camera. The member reads the camera's place by reference through
  `currentPlace`, `distanceBand` and `placeAt`. Everything created is deleted (devices, places, the group
  and its memberships, the binding) and a zero-row check runs; incomplete cleanup fails the step.

No real person's location is read or written. The linked suites:

- `tests/unit/location-place-reads-postgres.spec.ts`: containment edges, "since", bands and the
  operation-only address, each read refusing SYSTEM and an identity without an issuer.
- `tests/unit/location-places-devices-postgres.spec.ts`: places and enrolment over HTTP, who may change
  what, and migration 176's identity fence at the database.
- `tests/unit/location-places-browser.spec.ts`: the Settings, Location page in Chromium on localhost with
  `MOCK_OIDC`. An admin adds places and enrols a node, a camera and a TV at places; a member sees the
  group camera view-only and cannot change any of the three.
- `tests/unit/location-fleet-id-shape.spec.ts`: the location slice's copy of the camera and drone fleet id
  shape stays equal to `CAMERA_ID_RE` and `DRONE_ID_RE`.
- `tests/unit/test-lab-location-places-registration.spec.ts`: this card on the fixture server, green and
  red.

Run them with `npm run test:location` (Docker is required for the PostgreSQL suites). That is local
evidence. After a deploy, run the card from the Test Lab.

### Location reminders and group sharing (ADR-169 L5)

**Location — reminders and group sharing (ADR-169 L5)** (`location-reminders`, Tools) runs two steps
on the build that is running:

- `reminder-routes` runs as the signed-in person. The rules, fires, shared-presence and group-sharing
  reads must carry no coordinate. Accepting a restricted invitation and creating a guardian share are each
  refused without a fresh sign-in, a reminder at a place that is not theirs is refused, and the person's
  rules must not change.
- `reminders-lifecycle` runs the services the routes and Jarvis call for three uniquely tagged synthetic
  people on the real database, on a scripted server clock. "I'm at the grocery store, remind me next time
  to buy milk" must propose a place at the person's fix and save it on "yes"; the reminder must not fire
  while they stay and must fire exactly once when they return. The fire is delivered under the actor over
  the production Jarvis shelf rail (ids only) and the tier-aware senders: a deployment-tier channel must
  get only "You have a location reminder — open oshal", an own-tier channel the reminder. An
  operator-stamped session must find no place, subject or reminder text in the shelf row and no location
  rule or fire row at all. An admin's group notice must fire for the member who shared the place and never
  evaluate the member who did not, and a member must see the sharer's arrival by reference. Everything
  created is deleted (shelf rows, the group and its memberships, each person's location rows through the
  erase) and a zero-row check runs; incomplete cleanup fails the step.

No real person's location is read or written. The linked suites:

- `tests/unit/location-evaluator.spec.ts`: the scripted fix sequences through the pure presence stepper:
  edge jitter enters once, exit hysteresis, cooldown, once versus every visit, stale and back-dated fixes,
  all on server receipt time.
- `tests/unit/location-reminders-postgres.spec.ts`: the same through the real browser ingest on a private
  PostgreSQL owned by the enforcing role; a 100 m place for a person stored at `block`; two-rail delivery
  with tier-aware text; the daily cap and the recovery sweep; an operator-stamped session reading
  `jarvis_tasks` and `tickets` finds ids only; the Jarvis grocery-store sequence; the owner's purge.
- `tests/unit/location-group-shares-postgres.spec.ts`: a member who has not shared is never evaluated; a
  place outside the approved set is never evaluated; the cap, a foreign place and a foreign device are
  refused; revocation keeps the member's rows and empties the projection; restricted invitations and the
  acceptance function; guardian shares and their projection; an erased admin named nowhere.
- `tests/unit/location-jarvis-intent.spec.ts`: the parser, the place guess, proposal replies and the
  browser-session rule of the intent.
- `tests/unit/location-route-policy.spec.ts`, `tests/unit/location-rls-no-operator-guard.spec.ts` and
  `tests/unit/location-log-guard.spec.ts`: the declared step-up rule of every route, no operator bypass in
  migration 177, and no location data in a log line.
- `tests/unit/test-lab-location-reminders-registration.spec.ts`: this card on the fixture server, green
  and red.

Run them with `npm run test:location` (Docker is required for the PostgreSQL suites). That is local
evidence. After a deploy, run the card from the Test Lab.

### Location: a group drone reports under its own credential (ADR-169 L6)

**Location — a group drone reports under its own credential (ADR-169 L6)** (`location-device-ingest`,
Tools) runs two steps on the build that is running:

- `device-routes` runs as the signed-in person. The device ingest must refuse a browser session
  (401 `device_credential_required`), issuing a credential must be refused without a fresh sign-in
  (403 `step_up_required`), the devices list must name the kinds that report under a credential, and the
  person's devices must not change.
- `device-lifecycle` runs for three uniquely tagged synthetic people on the real database. An admin makes
  a group with a member and a group place, enrols a drone to the group and issues its credential. That
  credential then drives the real ingest over the loopback exactly as a drone node does (the bearer alone):
  the fix must be accepted, placed in the group place and stored as the device subject; the same
  credential must be refused on another device's path; the signed-in person must be refused a node token
  for the drone's id at `/api/join/enroll`; the member reads the drone by reference through
  `currentPlace`, `distanceBand` and `locatedDevice` and the stranger gets nothing. Everything created is
  deleted (the credential row, the device with its fixes, the place, the group and its memberships) and
  a zero-row check runs; incomplete cleanup fails the step.

No real person's location is read or written, and no position is logged. The linked suites:

- `tests/unit/location-device-ingest-postgres.spec.ts`: the credential behind the step-up, the ingest as
  the device subject, every refusal the slice names (each writes nothing), rotation, opting out and removal,
  and the kernel reads for a member and a stranger, over HTTP with the real CLI-token middleware.
- `tests/unit/location-token-scope.spec.ts`: the credential's scope, pure and through the real middleware;
  a node token and an account PAT unchanged by the new column.
- `tests/unit/location-route-policy.spec.ts`, `tests/unit/location-rls-no-operator-guard.spec.ts` and
  `tests/unit/machine-write-identity.spec.ts`: the declared routes, the static no-bypass guard over
  migration 178, and the machine-write class gate that discovers and drives the ingest.
- `tests/unit/test-lab-location-device-registration.spec.ts`: this card on the fixture server, green and
  red.
- `tests/unit/drone-node-location-fix.spec.ts`: the drone node itself, as its own process. A half credential
  pair or a device id that is not a location device id stops it at start (exit 1); with a credential a
  group admin issued, its fixes reach the real ingest as `POST /api/location/devices/<id>/presence` with
  the Bearer credential and no service secret, flagged mock for the sim engine, on the interval, and are
  stored as the device subject in the group place; `DRONE_LOCATION_INTERVAL_S=0` posts nothing. The card's
  lifecycle step posts its fix with its own request, so this suite is what proves the node's posting.

Run them with `npm run test:location` (Docker is required for the PostgreSQL suites). That is local
evidence. After a deploy, run the card from the Test Lab.

### Location: a map is found again where it was captured (ADR-169 L7)

**Location — a map is found again where it was captured (ADR-169 L7)** (`location-map-anchors`, Tools)
runs two steps on the build that is running:

- `map-posture` reads only the catalog. `spatial_scans` must carry `tenant_id` and
  `capture_session_id`; the group fence must be installed as a restrictive policy beside the member
  policy, and neither may name the operator flag; the owner fence and the scan-removal trigger must be
  installed.
- `map-lifecycle` runs for three uniquely tagged synthetic people on the real database and the real scans
  root. An admin makes a group with a member and a group place, and registers two group scans through the
  scan store, each naming a guided-capture session whose telemetry was written to the capturer's sidecar:
  one captured inside the place, one outside every saved place. Each scan is anchored from the GPS its
  own session recorded. On a later visit the member must get both from `mapsNear`, newest first and by
  reference, and open a group scan they did not capture. A stranger, operator-stamped or not, must get
  nothing from `mapsNear` and read neither scan. A member who is not an admin must be refused when
  anchoring a group's map. Everything created is deleted (the scans and with them their anchors, the
  capture sidecars, the place, the group and its memberships) and a zero-row check runs; incomplete
  cleanup fails the step.

No real person's location is read or written, and no position is logged. The linked suites:

- `tests/unit/location-map-anchors-postgres.spec.ts`: the slice's done-when through the real scan store,
  the real capture join and the real operations; who may anchor what; the anchor policies written to
  directly; the precision an anchor is stored at; re-anchoring; the erase and the export.
- `tests/unit/spatial-group-scans-postgres.spec.ts`: the ADR-111 amendment. A person's own scans are
  unchanged; a group's scan is reached only by its members; a scan's owner and group cannot be
  rewritten; a deleted scan takes its anchor with it; a group's scan is reconstructed as its capturer;
  the store's bootstrap against the migration.
- `tests/unit/spatial-capture-anchor.spec.ts`, `tests/unit/spatial-mapping-store.spec.ts` and
  `tests/unit/shared-geo.spec.ts`: the capture anchor, the store's statements, and the rounding reach.
- `tests/unit/location-rls-no-operator-guard.spec.ts`, `tests/unit/location-log-guard.spec.ts` and
  `tests/unit/provisioner-migrated-helpers-postgres.spec.ts`: no operator branch in migration 179, no
  location data in a log line, and the two new privileged functions on the provisioner's approved list.
- `tests/unit/test-lab-location-map-registration.spec.ts`: this card on a private database, green and
  red.

Run them with `npm run test:location` (Docker is required for the PostgreSQL suites). That is local
evidence. After a deploy, run the card from the Test Lab.

---

## Application-installed smoke cases

Active applications register their manifest `smoke:` declarations and optional
[versioned suite catalog](testing/package-test-catalog.md) through the application
loader. Reload and update replace that app's cases; deactivation and uninstall retract them. A fresh
controller rebuilds the inventory through normal app loading. Each case carries its owning app,
installed version, source/content revision, level and execution prerequisites. The catalog also identifies
apps without declarations and groups whose coverage belongs to their members.

The Lab displays only apps available to the caller and checks access again before each execution.
Eligible GET/HEAD cases run through the existing installation smoke verifier. Service-authenticated
checks require an operator; PAT checks require the caller's PAT. AI and mutating cases remain
registered but pending a suitable approved runner. Registration itself does not execute tests.

The **Installed application test registration** card (`installed-app-tests`) checks catalog identity
and prerequisites without running application smokes. **Connector sign-in callback boundary**
(`connector-oauth-boundary`) probes anonymous refusal paths without connecting a provider.
**Multi-store discovery** (`multi-store-discovery`) reads registry status and qualified package
identities without installing packages or changing trust. Their linked local suites run using
`npm run test:platform-readiness`.

**Exact-SHA package audit gate** (`package-audit-exact-sha`, Tools, explicit-only) installs the
first store package that has an audited catalog binding. It uses the real installer in `enforce`
mode and writes into a temporary directory. The directory is removed afterwards and the removal is
verified. Nothing is deployed or loaded. A pass means the installed commit is exactly the audited
SHA. A gap means the store publishes an attestation it cannot prove: the audited commit is not
served there, or the source changed after the audit. The linked real-Git suites cover the evidence
re-hash, the stale-source and version refusals, and the unpinned compatible fallback. Run them with
`npx vitest run tests/unit/package-audit-installer.spec.ts tests/unit/test-lab-package-audit-registration.spec.ts`.

**Yahoo Mail connector (app password, read-only IMAP)** (`yahoo-mail-connector`, Tools) checks that
the Yahoo credential stays behind sign-in. Its linked suites run the real IMAP client against a
loopback responder. They cover the closed `address:app-password` schema, the fixed
`imap.mail.yahoo.com:993` endpoint, a read-only `EXAMINE` with one bounded envelope `FETCH`, the
caller's personal grant, and LOGIN refusal. Run them locally with
`npx vitest run tests/unit/imap-mail-reader.spec.ts tests/unit/connector-yahoo.spec.ts`. Signing
in to a real Yahoo mailbox is an operator acceptance step, and no suite here performs it.

**ESPN Fantasy league reads (fantasy-leagues kernel skill)** (`espn-fantasy-league-reads`, Tools)
checks that the ESPN Fantasy cookies stay behind sign-in. Its linked suites run the
`fantasy-leagues` kernel skill ([ADR-146](adr/146-fantasy-football-draft-platform.md) D2) against a
loopback host shaped like ESPN's fantasy API: both cookies on league reads and none on the public
feed, the fixed ESPN host under a hostile league id, a refused, an unavailable and an unreachable
ESPN kept apart, and `espn_s2` absent from every log event and returned value. Run them locally with
`npx vitest run tests/unit/fantasy-leagues-espn-client.spec.ts tests/unit/kernel-skills.spec.ts`.
Reading a real league is an operator acceptance step behind a signed-in session.

Eligible offline package Node suites now use a disposable runner with Run/Cancel controls and
durable versioned history. See [package test execution](testing/package-test-execution.md) for
supported prerequisites, current-user authorization, isolation and local regression commands.
Unsupported runners remain pending; further runner fixtures and remaining package adoption are in
the [application registration backlog](backlog/app-test-lab-registration.md).
Source registration and fixture tests do not establish deployed provider or production results.

The autonomous-run cards also register isolated nightly regressions, manifest bot initialization,
first-run setup, specialist facts and Jarvis briefing preferences. Access administration includes
principal inventory, Users, root protection and scoped audit history. Each card's linked source suites
have a matching command in [tests/README.md](../tests/README.md); browser probes only perform their
documented read steps and never execute arbitrary host commands.

## Part 2 — Nightly golden loop

Submits "golden" complicated requests as **real tickets**, lets them flow through the **same swarm
queue**, polls each to a terminal state, reads the produced result, and **grades it against a fixed
expected output**. Failing scenarios are **re-run** (the swarm is non-deterministic — keep the best
attempt); a scenario still failing gets a **drafted suggested fix** written into the report.

### Propose-you-approve (the safety model)

The loop runs unattended overnight, so it is deliberately bounded:

- It **measures, re-runs, and proposes**. It **never edits framework prompts/code** and never
  auto-applies a fix.
- It auto-commits **only** the report + the score baseline (`docs/test-lab-reports/`).
- Any suggested fix lands in the morning report as a proposal. You approve one, then it gets applied
  + committed (by you / by a follow-up task) — nothing that could break the platform ships while you
  sleep.

### How grading works

Per golden scenario (`src/app/routes/test-lab-golden.ts` → `GOLDEN[]`), the expected output is:

- `mustComplete` — the swarm must reach `complete` for the run to count as a **pass** (see below).
- `requiredKeywords` — all must appear in the produced result.
- `requiredArtifacts` — at least N files in the ticket's workspace deliverables.
- `rubric` — what a correct result looks like, scored 0-100 by an LLM judge.

Heuristic score (terminal status + artifacts + keywords + test-construct credit) is blended with the
judge score; `passScore` is the threshold. A run **passes** only when `score ≥ passScore`, a real
deliverable was produced, **and** the swarm actually reached `complete`. A run that produced a good
deliverable but **escalated** instead of completing is surfaced as `degraded` (not pass, not
hard-fail) — escalation is currently the *dominant* golden outcome (the swarm auto-escalates from
`in_process_build`), so we keep that visible rather than counting it as green. Each run is persisted
to `test_lab_golden_runs` **and** to `eval_runs` (the Eval Wall — Part 3), with cost (read from the
central ledger), latency, and retries captured.

### Headless wiring (why it can run with no browser)

- The engine is mounted under `serviceSecretOr()` at `POST /api/test-lab/golden/run`, so the
  host-side runner authenticates with `SWARM_SERVICE_SECRET` (no OIDC session). It also sends the
  configured `TEST_LAB_OWNER_SUB` in `X-OSHAL-User-Sub`; the API accepts that binding only after
  validating the secret, then stamps it as a non-operator database identity for the entire batch.
- Tickets are created server-side via `ctx.ticketService` with that same owner sub, so the row owner
  and the RLS connection identity agree. A secret-authenticated request missing the owner binding is
  rejected before any scenario starts instead of receiving cross-tenant operator access.
- Results are read from the bind-mounted `workspace-shared/<ticketId>/deliverables/`.
- The git commit happens on the **host** (the report path `docs/` isn't mounted into the container).

### Setup

```powershell
# 1. (one-time) register the nightly Windows task — runs 04:30 daily, wakes the PC, catches up after sleep
powershell -ExecutionPolicy Bypass -File scripts/register-test-lab-nightly.ps1

# 2. test it right now (creates real tickets; takes as long as the swarm needs)
node scripts/test-lab-nightly.mjs all          # full set + commit the report
node scripts/test-lab-nightly.mjs g-phone-validator --no-commit   # one scenario, no commit
```

Requirements: `SWARM_SERVICE_SECRET` and `TEST_LAB_OWNER_SUB` set in `.env`; the api container
running; the swarm worker bots online (the tickets need them to produce results).

### The morning report

Written to `docs/test-lab-reports/<date>.md` (+ `latest.md`, `baseline.json`) and git-committed:

- a pass/fail table with each scenario's score, the **trend vs last night**, attempts, and ticket
  status;
- per-scenario detail (what the grade was based on);
- any **suggested fix** as a clearly-marked proposal awaiting your approval.

### Tuning

- `TEST_LAB_MAX_ATTEMPTS` (default 2) — re-runs before giving up.
- `TEST_LAB_OWNER_SUB` — required OIDC sub the nightly runner sends as its trusted user binding;
  tickets, evaluation calls, persistence, and batch polling are scoped to this owner.
- `TEST_LAB_API` (host runner) — defaults to `http://127.0.0.1:${OSHAL_API_PORT:-35457}` (the
  api container's 5000 published to the host). The runner waits for this endpoint to be reachable
  before kicking off, so a 04:30 wake where Docker is still starting doesn't lose the night.
- Add/edit golden scenarios in `GOLDEN[]` in `src/app/routes/test-lab-golden.ts` (then rebuild).

### Not yet (deferred)

- Emailing the report (the send endpoint is `requiresAuth`, not service-secret; the report is
  committed + on disk for now).
- Auto-applying an approved fix (today: you approve, then it's applied as a normal change).
- Awaiting async sub-artifacts (resume/deck generation) to full completion before grading.

---

## Part 3 — Eval Wall (the green wall)

Every golden run is also written to `eval_runs` and rolled up on a read-only dashboard, so the lab is
a **history**, not just "0/1 today." Open it at **cockpit → Optimization → Eval Wall**.

It shows the axes a buyer expects, with a per-day success-rate trend sparkline:

- **Success rate** over the window, **cost**, **avg latency**, **avg retries**, **quality** (mean
  final score), and **security posture**.
- **Cost is read from the central ledger**, not re-instrumented: `captureTicketCost` sums the
  ticket's `chat_tasks` cost via `ticket_task_links` (the same place every LLM call records), so it
  works for any ticket.
- **Security posture** is the viewer's live Security Center findings (open critical/high), not a
  per-run number.
- **Honest-null:** anything a run didn't measure shows as a muted dash, never a fabricated 0.

It is self-populating — the nightly golden loop writes each run. Seed history without waiting:
`node scripts/eval-wall-seed.mjs`.

API: `GET /api/eval-wall/summary` (rollup + `trend` + `securityPosture`), `/runs`, `/app`
(`requiresAuth`). Unit tests for the rollup/trend math: `tests/unit/eval-wall-rollup.spec.ts`.
