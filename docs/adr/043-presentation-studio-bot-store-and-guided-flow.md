# ADR-043 — Presentation Studio: bot-scoped store, visible save target, real preview, guided flow

- **Status:** Proposed
- **Date:** 2026-06-17
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-037 (communications swarm — reference app)](037-communications-swarm.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-041 (per-user storage targets)](041-per-user-storage-targets.md)

## Context

The Presentations app shipped 2026-06-16: a real `.pptx` generator (pptxgenjs) with a
template gallery, an outline editor, AI outline drafting via the comms bot, and a "My decks"
list — saving through ADR-041's `saveContent(user, 'files', …)`. The core round-trip
(topic/outline → generate → save → download) works.

Three things the operator expects from a "studio" are only half-built:

1. **Where files save is invisible and unchosen.** `POST /pptx` already accepts a per-save
   `saveTo` override (`cleanOverride` in the store-side `bot-presentation-routes.ts`),
   but the surface never sends it and never shows the destination. A deck silently lands in the
   user's default Files target. The user can't see or pick where it goes before generating.
2. **"Preview" is a download link, and the store isn't organized by app.** The "My decks" panel
   reads metadata rows from `oshal_presentations` (title, slide count, link) — there is no actual
   preview of the deck, and nothing scans a save directory. The OSHAL-local path is a flat
   `userfiles/{sha256(sub)}/` per-user dir ([storage-target.ts](../../src/app/routes/storage-target.ts)) —
   every app's artifacts share one folder. There is no per-app/per-bot home for generated content.
3. **The "walkthrough" is a static two-step form.** The `deck-builder` guide persona
   ([ai-lab/bot-personas/deck-builder.yaml](../../ai-lab/bot-personas/deck-builder.yaml)) describes a
   goal → audience → spine → refine → generate conversation, but it is **not wired into the
   surface** — there is no chat panel. The persona exists; the guided flow does not.

This is the gap between "a generator with a form" and "a studio that owns its domain" (ADR-036).
The bot should own a real, browsable store and drive the build conversationally; the surface is a
view over that store.

## Decision

Build the second layer in this order — **B → A → C** — because the bot-scoped store is the
foundation the visible target and the preview both read from.

### B. Bot-scoped store: `oshal/{bot-id}/` + real preview

- **Folder convention.** Generated artifacts live under a per-bot subfolder of the user's Files
  target: `oshal/{bot-id}/{filename}`. For the Presentations app, `bot-id` is the `deck-builder`
  agent (`a0000000-0000-0000-0000-000000000042`). This applies across backends — a folder prefix
  in Dropbox/GitHub, and `userfiles/{sha256(sub)}/oshal/{bot-id}/` for OSHAL-local. One app's
  output is no longer mixed into the shared user dir.
- **`saveContent` gains a `subfolder`.** Extend the ADR-041 save layer (not the caller) so every
  generator gets the convention for free: `saveContent(ctx, sub, kind, name, buf, override?, subfolder?)`.
  The Presentations route passes `subfolder = 'oshal/' + DECK_BUILDER_AGENT_ID`.
- **List by scanning the bot's folder, not (only) the metadata table.** "My decks" reflects what
  is *actually* in the store — including decks the user moved/added — by listing the bot's
  subfolder on the resolved backend. The `oshal_presentations` table stays as a fast index + cost
  link, but the store is authoritative (so a deleted file disappears, an added one shows up).
- **Real preview.** Each deck gets an in-surface preview, not just a download link: render the
  deck's slide titles + first bullets (we already have the outline/sections) into a lightweight
  thumbnail/preview card. Full visual slide rendering (PNG per slide) is a later step, explicitly
  deferred (see Consequences).

### A. Make the save target visible and chosen

- The surface shows the **resolved destination** before generate ("Saving to: Dropbox /oshal/decks")
  and lets the user change it for this save — wiring the already-built `saveTo` override end to end.
- Defaulted from ADR-041 prefs, never a blank prompt. Changing it here is a per-save override, not
  a prefs edit (prefs are still owned by the Storage Assistant, ADR-041 layer 3).

### C. Wire `deck-builder` into the surface as a guided chat

- Add a right-rail chat panel to the Presentations surface that talks to the `deck-builder` bot via
  the **interactive direct-sync path** (`BotNodeClient.execute(agentId, prompt)` → bot
  `POST /api/swarm-execute`, cost auto-tracked to `chat_tasks` under agent `…042`) — per ADR-036,
  **no queue**, and the bot does the reasoning so cost + per-bot settings apply.
- The conversation builds the outline turn-by-turn (the persona's goal → spine → refine arc). When
  the outline is solid, the bot hands off to **Generate** — it populates the existing outline
  editor (the chat is an authoring aid over the same `/pptx` call, not a second generate path).
- This is the chat↔surface bridge backlog item, scoped to one app first.

## Consequences

- **Positive:** the Presentations app becomes a real ADR-036 bot-owned app — the `deck-builder`
  bot owns a browsable `oshal/{bot-id}/` store, the surface is a view over it, and every transport
  (form, AI-draft, guided chat) routes through the same accountable bot. The `oshal/{bot-id}/`
  convention generalizes to every future generator app (storage, social exports) for free.
- **Negative / cost:** listing by directory scan is a backend round-trip per load (Dropbox/GitHub
  API) — keep the metadata table as a cache and scan lazily. The guided chat adds an LLM call per
  turn (captured to `chat_tasks`), unlike the zero-cost form.
- **Deliberately deferred:** full per-slide visual rendering (PNG thumbnails of actual slides) —
  the first preview is outline-based (titles + bullets), which is cheap and needs no headless
  renderer. In-browser live `.pptx` editing is out of scope (download to edit). Moving/deleting
  decks from the surface is a `deck-builder` tool action, tracked but not in this cut.
- **Migration:** existing decks saved to the flat user dir stay where they are; the convention
  applies to new saves. "My decks" shows both (table index covers the old ones).

## Implementation

**B — bot-scoped store + real preview (built 2026-06-17):**
- `src/app/routes/storage-target.ts` — `saveContent` takes an optional `subfolder`; `sanitizeSubfolder`
  (no traversal); new `listFolder(ctx, sub, kind, subfolder)` scans the resolved backend
  (oshal-local / Dropbox / GitHub), returning [] for a not-yet-created folder.
- `src/app/routes/storage-routes.ts` — `/local/download` accepts a sanitized `dir` subfolder.
- Store-side `bot-presentation-routes.ts` — decks save under `oshal/{DECK_BUILDER_AGENT_ID}/`;
  `oshal_presentations` gains an `outline` JSONB column (persisted on save); `/list` scans the store
  (authoritative for the current target), merges the table as a metadata cache + history on other
  backends, and falls back to table-only if the backend scan fails.
- Store-side `presentations.html` — "My decks" cards render an outline-based preview (slide titles +
  first bullets), no download needed.

**A — visible save target (planned):** surface the resolved destination on the `/pptx` response +
a destination chip in `presentations.html` that sends the existing `saveTo` override.

**C — guided flow + chat-drives-editor (built 2026-06-17):**
- Store-side `bot-presentation-routes.ts` — `POST /guide`: the live editor state (title +
  slides) is sent to `deck-builder` via `BotNodeClient.execute` (direct sync, cost → `chat_tasks`
  under `…042`); the bot returns `{reply, actions[]}`. Actions are whitelisted + sanitized
  server-side (`set_title` / `set_outline` / `update_slide` / `add_slide`).
- Store-side `presentations.html` — a tabbed right rail (Guide / My decks); the Guide chat sends
  the live editor state + recent history and **applies the returned actions straight to the title /
  outline editor** (e.g. "change slide 2's title" updates it in place — no clicking across), with an
  inline note of what changed. Generate stays a manual click.
- `ai-lab/bot-personas/deck-builder.yaml` — documents the action vocabulary + "read the live state,
  only act on this turn's ask".

Chosen over the deferred cockpit cross-iframe postMessage bridge ([../BACKLOG.md] "Chat ↔ surface
bridge"): an in-surface chat is same-document JS, so it drives the editor directly without that
framework piece. The general bridge remains future work for cross-app cases.

**Deliberately deferred (this cut):** Generate-on-the-bot's-say-so (always a human click);
multi-session chat memory beyond the last few turns (the live editor state is the shared context);
the cross-app cockpit bridge.
