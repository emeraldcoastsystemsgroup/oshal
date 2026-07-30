# Creative Studio docs

The Google Vids remote-node video pipeline (ADR-080) — how episodes are written,
prompted, rendered, validated, and delivered.

- [kids-video-pipeline-lessons.md](./kids-video-pipeline-lessons.md) — the hard-won rules.
  Read before touching a render: the gates, the writing standard, the prompt standard,
  and the machinery traps that cost real money.
- [script-writer-brief.md](./script-writer-brief.md) — hand this to whoever authors
  episode packs. What the renderer needs, and the pitfalls that have ruined finished
  renders.
- [video-series-pipeline.md](./video-series-pipeline.md) — the swarm-wired pipeline: a user
  describes a series, the `screenplay-writer` bot writes it, the swarm storyboards and renders
  it. Architecture, the stage hand-off, the build traps, and the honest gap list. (ADR-082.)
- [joke-shorts-pump.md](./joke-shorts-pump.md) — running that pipeline on a schedule instead of by
  hand: the switches, what each cycle's refusal means, and what the render node has to have
  installed. Read the table of skip reasons before concluding the pump is broken. (ADR-120.)
