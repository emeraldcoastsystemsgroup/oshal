# Jarvis rich-response framework notes

> Historical snapshot from the mockup phase. Production now has a server-owned five-kind visual
> artifact path, cloud materialization, durable Discussion replay, and server neural TTS with browser
> fallback. Use the [as-built architecture](../../docs/architecture/jarvis-architecture-and-flow.md)
> and [JVV backlog](../../docs/backlog/jarvis-voice-and-visuals.md) for current status.

## What existed when this design lab was created

The production request path is:

```text
Cockpit iframe
  -> browser/server speech-to-text
  -> POST /api/jarvis/ask
  -> dedicated Jarvis bot-node
  -> AnyBot task controller
  -> GET /api/jarvis/ask/result polling
  -> Markdown/Mermaid renderer + browser text-to-speech
```

Important details:

- Jarvis is now a dedicated first-class bot-node with one stable session per user. Some comments and manifest prose still describe the older classify/delegate/synthesize path.
- The cockpit surface already renders escaped Markdown, images, links, tables, code, and Mermaid.
- Text-to-speech already avoids reading visual syntax aloud and tells the user when a table or diagram is on screen.
- The API boundary still transports a single `answer` string; there is no typed card/chart/form/gallery contract.
- The TV and Electron clients still render plain text, so any permanent renderer needs capability-aware fallbacks.
- The repository backlog already calls this north star the **Shared Response Renderer** and proposes typed `oshal:*` blocks with a component registry.

## Design constraints

1. **Voice and screen need different densities.** A short `spokenSummary` should be independent of the detailed visual blocks.
2. **The transcript must remain durable.** Rich presentation can enhance it, but a plain-text answer is still needed for history, TV, notifications, accessibility, and unsupported clients.
3. **Do not inject model-authored HTML into Jarvis.** Its cockpit iframe intentionally runs without a sandbox so microphone capture works. Typed components are the safe default; an HTML preview needs its own nested sandboxed iframe and strict sanitation.
4. **Actions are not links with prettier styling.** Action/form blocks must map to allowlisted framework operations, retain authorization, and require confirmation for mutations.
5. **The renderer should be shared.** A Jarvis-only implementation would deepen the current duplication across cockpit chat, Electron, TV, and app concierges.

## The three concepts

| Concept | Best at | Framework change | Main risk |
|---|---|---:|---|
| Conversation+ | Familiarity and fastest delivery | Low | Long answers turn chat into a scrolling dashboard |
| Adaptive Answer Canvas | Voice + glanceable visuals + useful actions | Medium | Needs clear focus/back behavior and a typed block contract |
| Conversation + Workbench | Iterative research, forms, and durable artifacts | High | Desktop density and artifact lifecycle complexity |

The recommended starting direction is **Adaptive Answer Canvas**, while preserving Conversation+ as the narrow/mobile fallback. The Workbench pattern can later activate for explicitly complex or iterative outputs.

## Suggested permanent response envelope

```json
{
  "answer": "Accessible text fallback and transcript content.",
  "presentation": {
    "version": 1,
    "spokenSummary": "Short sentence intended for TTS.",
    "title": "Human-readable answer title",
    "blocks": [
      { "type": "weather", "data": {} },
      { "type": "metric-grid", "data": {} },
      { "type": "line-chart", "data": {} },
      { "type": "table", "data": {} },
      { "type": "actions", "data": {} }
    ]
  }
}
```

Recommended first block set:

- `weather`
- `metric-grid`
- `key-value`
- `table`
- `line-chart`
- `bar-chart`
- `timeline`
- `image-gallery`
- `actions`
- `form`
- `download`
- `sandboxed-html-preview`

## Practical integration sequence after a concept is selected

1. Define and validate a versioned response schema while keeping `answer` required.
2. Build a shared, portable block registry with unknown-block and malformed-data fallbacks.
3. Wire the existing structured weather payload into the first deterministic visual demo.
4. Add the renderer beside the current Markdown path in a test-only preview surface.
5. Verify keyboard navigation, screen-reader announcements, reduced motion, narrow layouts, theme synchronization, and unsafe URL rejection.
6. Integrate into production Jarvis only after the interaction model is selected.
7. Reuse the same registry in Electron and add simplified TV renderers or plain-text fallback.
