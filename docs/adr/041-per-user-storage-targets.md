# ADR-041 — Per-user storage targets: Code vs Files routing

- **Status:** Accepted (foundation built; data-management bot built as the Storage Assistant)
- **Date:** 2026-06-16
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md), the connector hub, the file space

## Context

OSHAL generates content — code (from build swarms), files (PowerPoints from the Presentations
app, drafts, exports). It needs a per-user answer to "where does this go?" without hoarding
everything locally. Connectors already exist for the user's own storage (GitHub, Dropbox), plus a
limited local store. The risk is over-engineering: a per-app or per-filetype matrix would be
unusable.

## Decision

**Two buckets, each routable to any backend.**

- **Code** — generated code / dev work. Wants version control → defaults to **GitHub** (repo + folder).
- **Files** — artifacts (PowerPoints, drafts, exports). Wants a document store → defaults to
  **Dropbox** (folder), or **OSHAL-local**.

Backends: `dropbox` (a folder), `github` (repo + folder, default branch), `oshal-local` (a
quota'd per-user dir, ~250 MB — the always-available limited fallback). Either bucket may target
any backend; that flexibility is free.

**Smart defaults from what's connected:** Code → GitHub if connected else local; Files → Dropbox
if connected else local. So a new user gets sane routing with zero config.

**Three layers (built in this order):**
1. **Prefs + resolver (foundation, built).** `oshal_storage_prefs` (per-user, one target per
   bucket) + `resolveStorageTarget(user, kind)` + `saveContent(user, kind, name, buf, override?)`
   that writes to the resolved backend. Generators call this instead of hardcoding a backend.
2. **Settings page + per-save default (built).** `/api/storage` is a view over the prefs (pick
   the backend + folder/repo per bucket). Generators may take a per-save `override` (the
   "Save to…" choice) — defaulted from settings, not a blank prompt every time.
3. **Data-management bot — BUILT (2026-06-16) as the Storage Assistant.** `POST /api/storage/assistant`
   + the "Assistant" tab in the Storage app: you chat ("make me a repo called X", "save my files to
   Dropbox", "where do my files save?", "list my files"); the comms bot turns the message into a
   structured action and the **controller executes it with your token** (create_repo / set_target /
   get_prefs / list_files) — ADR-036 (bot reasons, controller acts; no DB creds in the bot). Reliable
   + reversible; create_repo is the only outward action and only runs when you ask. Future polish: a
   dedicated bot node (vs the comms bot doing NLU) + more actions (move/delete).
   --- original roadmap note: Per ADR-036, a bot owns the storage domain: it edits the
   prefs *and* has tools to act — `create a GitHub repo`, make a folder, "move this deck there" —
   conversationally. The settings page becomes a view over the bot's config; the resolver/save
   are tools the bot also uses. This is why the foundation comes first: the bot needs those tools
   to exist.

## Consequences

- **Positive:** one source of truth for "where"; generators are backend-agnostic
  (`saveContent`); the Presentations app saves to the Files target automatically; user owns
  their data (their GitHub/Dropbox), with local as a bounded fallback.
- **Negative:** GitHub-as-target commits via the contents API (default branch, base64) — fine
  for artifacts/small code, not large binaries or full project trees (that's a build-swarm push,
  not this). The local quota (250 MB) is a hard cap, not a soft warning.
- **Deliberately NOT done:** per-app or per-filetype routing (overcomplicated); a global "primary
  storage" separate from the two buckets (the per-bucket default *is* the primary).

## Implementation (as built)

- `src/app/routes/storage-target.ts` — prefs schema/get/set, `resolveStorageTarget`, `saveContent`
  (dropbox / oshal-local / github). **Kernel skill — stays core.**
- The `/api/storage` surface (settings page, GET/PUT `/prefs`, `/dropbox/folders` +
  `/github/repos` pickers, `/local/{list,download}`, the Storage Assistant) **carved to the
  `storage` package in the oshal-applications store 2026-07-19** (ADR-085 Wave 2, "skill with
  a surface" — the package serves `tools/storage-settings.html` / `tools/storage-assistant.html`
  from its own dir). oshal-local `downloadUrl`s from the kernel skill now point at the
  kernel-mounted `/api/files/download?provider=oshal-local` so the skill never emits URLs into
  a package mount.
- Wired: `POST /api/presentations/sections/pptx` saves via `saveContent(user, 'files', …)`.
- Surfaced: the storage package manifest (settings + assistant + file browser) in the catalog.
