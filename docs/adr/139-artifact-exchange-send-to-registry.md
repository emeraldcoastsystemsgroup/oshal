# ADR-139 — Artifact exchange: one "Send to…" registry instead of N×M point integrations

**Status:** Accepted (staged) — operator approved the staged build 2026-09-04 ("ok lets do it in stages") after a design review that surfaced two under-specified spots, resolved in amendment A below. **Stage 1 shipped**: the shared registry + handle store (`src/shared/artifact-exchange/`), the `/api/artifacts` routes + `send-to.js`, fail-closed `artifacts:` manifest parsing with activate/deactivate lifecycle, the cockpit `artifact=` forward, and Portrait Studio as the first registered destination — full loop operator-verified in the browser. **Stage 2 shipped (Amendment B)**: the first kernel built-in destinations — **Email it…** (an in-place compose overlay; the artifact rides as an attachment over the caller's own mailbox, confirm-gated) and **Save to OSHAL Storage** (post-mode into the always-present oshal-local store, which `uploadBytes` now supports) — plus the files browser instrumented as the first document-hub surface (📤 per file). `overlay` is a kernel-reserved dispatch shape: manifests declaring it fail the load, so an app can never point the overlay at an arbitrary page. Stage 3 (RAG ingest after the ADR-135 upload fix, Jarvis summarize, sources/pickers, NL leg) remains open.

**Date:** 2026-09-04

**Related:** [ADR-036](036-bot-owned-application-architecture.md) (bot owns the domain, surface is a view),
[ADR-085](085-remote-app-packages-and-registries.md) (manifests as the superset contract),
[ADR-090](090-skills-as-first-class-packages.md) (`uses:` capability wiring),
[ADR-097](097-app-suites-primary-categorization.md) (manifest metadata discipline),
[ADR-108](108-office-delivery-adapters.md) (delivery adapters, "email it"),
[ADR-135](135-print-to-swarm-and-print-to-rag.md) (print intake; the `/api/rag/upload` PDF-mojibake defect gates one destination here).

---

## Context

The operator's framing, verbatim intent: *"for any artifact (images, documents, etc.) there should be a
general swarm service that apps register with on load, that subscribes artifact types to applications,
such that an application or service can be selected in the swarm from an object — and vice versa. If I'm
in the document hub and I right-click a PDF, maybe I see: send to RAG, email, copy to swarm memory,
summarize with Jarvis, send to a social app… and the trigger has an action too — send to email should pop
the email screen with the document already attached."*

Today every one of those connections is a **point integration, built once per app**:

- Portrait Studio just shipped its own email modal over `sendGmail`/`sendOutlookMail` (store 1.6.0).
- AI Office ships its own `POST /email` over the same two senders (ADR-108).
- career-digest wires the same senders a third way for its notifier.
- RAG ingestion has a print rail (ADR-135), an upload route, and nothing callable from another app's surface.
- The storage rail (`/api/files`) has a picker that Portrait Studio embedded by hand; the next app that
  wants "choose a file from connected storage" copies that modal again.

That is the N×M shape: N artifact-producing surfaces × M things you can do with an artifact, each pair
hand-built or absent. Every pair re-solves the same three problems — *how do I hand bytes across an app
boundary without breaking per-user isolation, how does the user see what's possible, and how does the
destination open pre-loaded* — and each solves them slightly differently. The swarm feels like separate
apps precisely because the connections are bespoke.

What already exists and must not be rebuilt: the manifest loader (apps declare surfaces/bots/routes and
the kernel wires them at load), the app-access machinery (per-caller tier filtering in the manifest route
mounter), the `?app=` URL contract (the cockpit navigates by URL, URL is the single source of truth), the
ADR-108 mailbox rail, `/api/files`, `/api/rag`, and owner-scoped serve routes in every app. This ADR is
the thin layer that composes them; it deliberately adds **no new way to move credentials and no new
execution path**.

## Decision

Add one small kernel feature — **artifact-exchange** — with four parts: a registry, a claim-ticket handle
service, a menu endpoint, and one shared cockpit menu component. Apps join by declaring an `artifacts:`
block in `oshal-app.yaml`; kernel-resident capabilities (email, RAG, Jarvis) register through the same
interface at boot, so built-ins are not special-cased.

### D1 — The registry: apps subscribe artifact types at load

`oshal-app.yaml` gains an optional block, parsed by the swarm-app loader exactly like `ui.static`:

```yaml
artifacts:
  accepts:                                  # this app as a DESTINATION
    - id: restyle                           # stable per-app action id
      label: Restyle in Portrait Studio
      icon: 🎨
      types: [image/*]                      # MIME globs this action takes
      mode: open                            # open the surface pre-loaded (no URL template —
                                            # the cockpit navigation contract is fixed, see D4a)
    - id: rag-ingest
      label: Ingest to RAG
      icon: 📚
      types: [application/pdf, text/*]
      mode: post                            # …or act headlessly and toast the result
      endpoint: /api/rag/ingest-artifact
  provides:                                 # this app as a SOURCE (phase 3)
    - types: [image/png]
      list: /api/portrait-studio/portraits  # a picker can enumerate the caller's artifacts
```

Rules, all fail-closed in the loader (the `suite:` discipline): unknown `mode`, a post action
without a root-relative `/api/...` endpoint, an `open` action *with* an endpoint, or a malformed
type glob **fails the app load**. A destination that isn't registered simply never appears — there
is no "generic open" fallback. (Amendment A dropped the per-action `open:` URL template from the
original draft: navigation is one fixed cockpit contract, not N app-authored URLs to validate.)

### D2 — Handles: a claim ticket, not a byte copy

Artifacts never travel by embedding bytes in URLs or by one app reading another's storage. The exchange
mints a **handle**:

- `POST /api/artifacts/handles` `{ source: <same-origin URL of an existing owner-scoped serve route>,
  type, name }` → `{ ref: "art_<128-bit token>", expiresAt }`.
- `GET /api/artifacts/handles/:ref` → metadata (type, name, size when known).
- `GET /api/artifacts/handles/:ref/content` → the bytes.

The handle row stores the **locator plus the minting caller's sub**; resolution re-fetches the source
server-side **as that caller**, so ownership is enforced twice — at mint (you can only point at what you
can already read) and at resolve (the fetch runs with your identity, through the same auth-gated route
that served you the artifact in the first place). Handles are short-TTL (15 minutes), owner-bound (only
the minting sub resolves them), audit-logged, and carry no bytes at rest — the token-broker discipline,
not a new blob store. Source URLs must be same-origin app routes; `file://`, absolute external URLs, and
container paths are refused at mint.

### D3 — The menu: one question, one answer, caller-scoped

`GET /api/artifact-actions?type=application/pdf` → every registered `accepts` entry whose glob matches,
**filtered by the caller's app access** (the same tier resolution the route mounter already applies — a
guest sees only what a guest may open). The answer is data, not markup:

```json
{ "actions": [
  { "app": "email-summarizer", "id": "compose", "label": "Email it", "icon": "✉️", "mode": "open" },
  { "app": "rag",              "id": "ingest",  "label": "Ingest to RAG", "icon": "📚", "mode": "post" }
] }
```

One shared cockpit component (`send-to.js`, served like RibbonNav) renders it: any surface — document
hub, a gallery card, a chat attachment — calls `oshalSendTo({ type, name, source })` and gets the menu,
the mint, and the dispatch for free. Surfaces stop building bespoke share buttons; they expose one
entry point ("Send to…" / right-click) and inherit every destination registered now or later.

### D4 — The trigger: open pre-loaded, or post and toast

- **`mode: open`** — the component mints a handle and navigates the cockpit to the destination's own
  surface with the ref in the URL: `/cockpit/?app=email-summarizer&artifact=art_xyz` (the `?app=` contract;
  the URL stays authoritative and bookmarkable-dead — an expired ref renders the app's normal empty
  state, never an error page). The app reads `artifact=` at boot, resolves the handle, and lands
  pre-loaded: the email surface opens **compose with the document attached**; Portrait Studio opens
  Step 1 with the image already in the crop stage.
- **`mode: post`** — the component mints a handle and POSTs `{ ref }` to the declared endpoint (an
  ordinary auth-gated app route; the mounter guards it like every other). The response is toasted:
  "Ingested to infra-runbooks (3 chunks)."

Nothing about `post` mode is fire-and-forget spending: a destination whose action costs money or acts
outwardly (email, social posting) either uses `open` mode — the user finishes the action in the
destination's own UI — or carries the standard `confirm:true` 428 gate behind its endpoint. The registry
never bypasses a destination's own consent gates.

### D4a — Amendment A (operator review, 2026-09-04): navigation mechanics and the destination contract

The review surfaced two under-specified spots ("every app is going to need a path… there will need
to be some controller that opens a new tab or updates the surface in place… have you really thought
this out"). Resolutions, now binding:

**One controller, one navigation contract.** There is exactly one dispatch controller — the shared
`send-to.js` — not one per app. It runs inside the source surface's iframe and hands navigation to
the shell: `window.top.location = /cockpit/?app=<name>&artifact=<ref>` (same-origin, rides the
existing `?app=` URL contract, back-button returns). The cockpit's `renderToolView` forwards a
shape-checked `artifact=` ref onto the destination surface's iframe URL — that is the whole
mechanism. **Default = update in place** (same tab); new-tab comes free because menu entries can be
dispatched from links (ctrl/middle-click); an in-place "peek" overlay is a later enhancement, not
the spine. Consequence: `mode: open` needs **no per-action URL template** — the original draft's
`open:` field is dropped, so there are no N app-authored navigation URLs to validate.

**What a destination must actually implement** (the receive checklist — this is the whole per-app
cost):

| Mode | Must implement | Typical size |
|---|---|---|
| `open` | On surface boot, read `artifact=` from its OWN URL; `GET /api/artifacts/handles/:ref/content`; feed the blob into the existing upload/import path. An expired/foreign ref resolves 404 → render the normal empty state, never an error page. | ~15 lines |
| `post` | One auth-gated endpoint on its own mount taking `{ ref }`; resolve content the same way; answer `{ ok, message }` for the toast. Outward-acting endpoints keep their own `confirm` gates. | one route |

Apps that register nothing implement nothing and lose nothing. Source-side instrumentation (the
"Send to…" button on an artifact-bearing UX object) is one call —
`oshalSendTo({ type, name, source }, anchorEl)` — added per surface, incrementally; the serve URL
it points at is the owner-scoped route the surface already renders from.

### D5 — Who integrates, day one and later

| Destination | Types | Mode | Rides |
|---|---|---|---|
| **Email compose** | `*/*` | open | the ADR-108 mailbox rail; the email surface gains an `artifact=` compose param |
| **RAG ingest** | `application/pdf`, `text/*` | post | `/api/rag` + doc-extract — **gated on the ADR-135 upload-mojibake fix** |
| **Jarvis — summarize** | `application/pdf`, `text/*` | open | the existing Jarvis ask rail, prompt seeded with the artifact |
| **Storage — save to…** | `*/*` | post | `/api/files` upload; provider chosen in the toast/dialog |
| **Portrait Studio** | `image/*` | open | Step 1 pre-load (also the proof app for `open` mode) |
| **AI Office** | `text/markdown`, `text/plain` | open | outline import |
| **Switchboard / social** | `image/*`, `video/*` | open | its own compose + consent gates |
| **Swarm memory** | `text/*` | post | memory ingest, `trust: untrusted` fencing per ADR-135 |

Sources (`provides` + the shared picker) are phase 3: the storage picker Portrait Studio hand-embedded
becomes the generic "pick an artifact" dialog, and any app that registered `provides` shows up as a tab
in it — the inverse direction the operator asked for ("it can be a source object or a destination
object").

The NL leg reuses the same registry: "Jarvis, send this to LinkedIn" resolves against
`/api/artifact-actions` like the menu does — one catalog for humans and bots. Later phase, no new
mechanism.

### D6 — What this deliberately is NOT

- **Not a new execution path.** `post` endpoints are ordinary app routes; `open` is ordinary cockpit
  navigation. No bytes or credentials ride the registry.
- **Not a tool bus.** Model-visible tools, deterministic provider intents, and the harness boundary are
  untouched — this is surface-to-surface plumbing for the signed-in user.
- **Not a storage system.** Handles hold locators, not blobs, and expire in minutes.
- **Not automatic.** Every dispatch is one explicit user gesture; outward-acting destinations keep their
  own confirm gates (automation stays opt-in, default off).

## Alternatives considered

| Option | Shape | Verdict |
|---|---|---|
| A — status quo | each app hand-wires each capability | N×M builds, proven drift (three bespoke email integrations already) |
| B — **this ADR** | registry + handles + one menu | N+M: an app registers once, every surface sees it; core addition is small and additive |
| C — browser-only share layer | surfaces postMessage each other, no server registry | loses caller-tier filtering, the NL/bot leg, and cross-surface handles; every iframe pair becomes a bespoke protocol again |
| D — full MCP-style bus | artifacts as tools on a message bus | overkill; blurs the Rule-0c kernel/app boundary and the model-visible-tool line for a UI-integration problem |

**Cost (option B):** one new kernel slice (~registry + handle table + two routes + one cockpit JS
component), one loader extension, and per-app registration that is 5–10 manifest lines plus an
`artifact=` boot read for `open`-mode apps. **Benefit:** every future app inherits every destination on
day one, and the swarm's surfaces stop being islands — the integration compounding the operator named
("make the swarm more integrated with itself").

## Rollout

- **P1 (prove the spine):** registry + manifest parsing + handle service + `/api/artifact-actions` +
  `send-to.js`; built-ins **email compose** (open) and **storage save-to** (post); Portrait Studio
  registers `accepts: image/*` as the store-side proof. RAG ingest joins the moment the ADR-135 upload
  fix lands (ingesting mojibake would poison corpora).
- **P2 (spread the menu):** document hub right-click, Jarvis summarize, swarm memory, AI Office import.
- **P3 (sources):** `provides` + the generic picker; the NL/bot resolution leg.

Each phase ships with guards: loader rejection specs for every malformed-declaration shape, a real-DB
handle spec (mint/resolve/expiry/cross-user refusal — the isolation boundary, tested like the token
broker), and one e2e per mode (open lands pre-loaded; post toasts and the destination state changes).

## Consequences

- Core gains a small load-bearing slice — this is exactly the "needs approval first" class of core
  change, hence Proposed with nothing built.
- `oshal-app.yaml` grows an optional block; ADR-085's superset contract absorbs it (old kernels ignore
  it, the loader validates it where supported).
- Bespoke share UIs (Portrait Studio's email modal, AI Office's email endpoint) keep working; they can
  fold into registrations over time rather than being migrated by force.
- A destination that is down or unauthorized simply vanishes from the menu — fail-closed, no dead
  buttons.
- The handle service becomes an isolation boundary and must be treated like graph-keys/token-broker:
  named guards, no convenience widenings.
