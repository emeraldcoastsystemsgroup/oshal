# ADR-110: Jarvis media input — image understanding as a transcription pre-pass

## Status

Accepted — BUILT + unit/route-tested (19 tests), deploy guard-deferred 2026-07-18 (ships on the next `oshal-api` rebuild; deployment follows `main`). Evidence: docs/evidence/jarvis-media-2026-07-18.md.

## Context

Users want to attach media when prompting Jarvis — **take a photo (phone camera), upload a photo, or add a document** — and have Jarvis actually reason over a photo, not just acknowledge it.

The obstacle is where Jarvis's reasoning runs:

- Jarvis is a first-class framework bot whose brain is the **Codex CLI** (`FORCE_LLM_PROVIDER: openai-codex`, gpt-5.5; `any-bot/server/services/llm/CodexProvider.js` → `codex exec` via `CodexCLIWrapper`). Codex is deliberately chosen over claude-code because it can shell out to run the mounted OSHAL CLIs in its sandbox (ADR-037) — but `codex exec` as wired is **text-only**: the wrapper flattens the message list into one text prompt (`args = ['exec','--json',…]`, no image flag).
- The any-bot JS providers (`AnthropicProvider`/`OpenAIProvider`) reference `msg.images` only to infer the message role and never attach it to the model content; `vision:true` in `provider-definitions.ts` is a catalog flag, not wiring. So there is **no live multimodal path** to the reasoning brain.
- `/api/jarvis/ask` rides the global `express.json()` ~100kb body cap; a base64 phone photo blows it.
- **Precedent:** voice input is already a controller-side transform — mic → `/api/voice/transcribe` (STT) → transcript text → `/ask`. The reasoning still runs on the bot; STT is an I/O transform, not reasoning. It runs in the controller, not on a bot, and nobody considers that an ADR-036 violation.

## Decision

Treat **image → text description as the visual analog of speech → text** — a controller-side transform, not a change to the reasoning brain.

1. **`POST /api/vision/describe`** (new `vision-describe` feature slice) turns attached image(s) into a factual text description via the swarm's OpenRouter credential driving a vision-capable chat model (`getSwarmApiKey('openrouter')`, default `google/gemini-2.5-flash`, `OPENROUTER_VISION_MODEL` overrides). Auth-gated (`serviceSecretOr(requiresAuth)`); mounted with its **own 12MB JSON parser**, excluded from the global 100kb parser in `server.ts`; **fail-closed 503** when no OpenRouter credential exists; cost recorded to `chat_tasks` under the Jarvis agent id.
2. The browser describes photos **before** `/ask` (exactly as it transcribes speech first), so base64 pixels never travel through `/ask`. `/ask` accepts an `attachments` array already reduced to text (image descriptions + doc text) and folds it into an authoritative-context block prepended to the Codex turn (`jarvis-attachments.ts`, a pure function). A media turn **skips** the deterministic weather/inbox/recall guards and goes straight to an enriched Jarvis turn.
3. Camera capture uses `<input type="file" accept="image/*" capture="environment">` (native camera app), **not `getUserMedia`** — the cockpit iframe blocks `getUserMedia` (Chrome refuses; the same constraint the voice path already works around).
4. **Documents (slice 1): text-based files** read client-side (txt/md/csv/json/log/code). The repo has **no binary extractor** (RAG upload does naive `buffer.toString('utf-8')`), so PDF/DOCX extraction is deferred to BACKLOG.

Why NOT wire codex `-i`/native vision instead: it is fragile on this host (subscription-token codex quirks, ADR-037 / portrait-studio landmines), version-dependent, and would still not cover documents. The transcription-transform keeps reasoning + cost on the accountable Codex bot (ADR-036), reuses a proven, keyed vision rail (the storyboard OpenRouter path), and mirrors a pattern operators already understand.

## Consequences

**Positive**
- Works today on the already-keyed OpenRouter rail; no new credential.
- Reasoning and cost stay on the accountable Codex bot (ADR-036); the vision transform's cost is recorded too.
- Sidesteps the `/ask` body-size cap and the iframe `getUserMedia` block.
- `vision-describe` is a **reusable seam** — any surface that needs "read a photo" can call it.

**Negative / limits**
- Two-stage (describe → ask) adds a round-trip.
- The reasoning model sees a *description*, not raw pixels — fine for Q&A, weaker for pixel-exact tasks.
- Multiple images share one combined description (per-image labeled sections not built).
- Documents are text-only until a binary extractor lands.
- A second small vision cost per media turn (recorded, not hidden).

If a truly multimodal reasoning brain is ever wired (e.g. a vision-capable any-bot provider), this transform becomes optional — not wrong.

## Related

[ADR-050](050-unified-assistant-route-orchestrator.md) (Jarvis unified assistant), [ADR-036](036-bot-owned-application-architecture.md) (the bot owns its domain; reasoning runs on the bot), [ADR-037](037-communications-swarm.md) (the codex bot shells out to mounted CLIs — why Jarvis is codex, hence text-only), [ADR-042](042-iot-connector-tenancy.md) (per-user connector-token isolation). Follow-up: PDF/DOCX document extraction (BACKLOG).
