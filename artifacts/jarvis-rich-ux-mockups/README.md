# Jarvis rich-response UX mockups

This is an isolated design lab. It does **not** modify or load the production Jarvis surface.

> Historical design note: the cloud-to-artifact interaction is now implemented in production for
> five server-owned visual kinds. The broader block catalog below remains exploratory. See the
> [as-built Jarvis flow](../../docs/architecture/jarvis-architecture-and-flow.md) and the
> [current open-work backlog](../../docs/backlog/jarvis-voice-and-visuals.md).

Editable review board: [Jarvis Rich Response UX Options in Figma](https://www.figma.com/design/G8xFFoQFT23nCoatfAN3FY)

## Revised ambient-stage concept

`transformation-stage.html` follows the clarified interaction model: the central Jarvis cloud gathers,
materializes into a visual answer while speaking, archives the result into the discussion, and returns
to its ambient cloud state. The center never scrolls; old answers can be rematerialized from the
discussion drawer.

Open `index.html` in a browser and compare three concepts against the same response data:

1. **Conversation+** — a low-change evolution of the current bounded conversation.
2. **Adaptive Answer Canvas** — a voice-first summary followed by a responsive visual canvas.
3. **Conversation + Workbench** — persistent chat beside a durable, tabbed answer artifact.

The scenario selector exercises three representative answer shapes:

- weather: visual conditions, metrics, line chart, table, and actions;
- morning briefing: metrics, timeline, attention chart, priority table, and actions;
- weekend planner: image gallery, timeline, comparison table, preference form, and actions.

All values are clearly labeled as demo data. The mockup uses a typed block renderer and escapes text rather than injecting arbitrary response HTML. Remote photos are restricted to `images.unsplash.com`; the layout remains usable if they fail to load.

## Useful direct links

- `index.html?concept=inline&scenario=weather`
- `index.html?concept=canvas&scenario=briefing`
- `index.html?concept=workbench&scenario=weekend`

## Original integration hypothesis (partially implemented)

Production now carries authoritative text plus optional trusted visual metadata for the five-kind
Jarvis slice. The generalized multi-block envelope below is still a design hypothesis tracked by
JVV-006 and JVV-007.

The live API can preserve its current `answer` string while adding a versioned optional presentation:

```json
{
  "answer": "Short accessible text fallback.",
  "presentation": {
    "version": 1,
    "spokenSummary": "Short sentence intended for TTS.",
    "blocks": []
  }
}
```

Typed blocks should cover weather, metrics, tables, charts, timelines, galleries, actions, and forms. Any future HTML preview should render in a separately sandboxed nested iframe; production Jarvis itself is intentionally unsandboxed for microphone access.
