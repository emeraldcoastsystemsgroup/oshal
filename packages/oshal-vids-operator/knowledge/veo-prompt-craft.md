# Veo prompt craft (for Google Vids "AI video clip")

Veo rewards **specific, cinematic, single-shot** descriptions. One clip = one
continuous shot, ~8 seconds. Don't pack a montage into one prompt — generate
multiple clips and assemble them on the timeline.

## The reliable prompt skeleton

`[subject] + [action] + [setting] + [camera move] + [lens/lighting] + [palette] + [mood] + [hygiene]`

Example (matches the brand look):
> A single dew-bead resting on a dark reflective surface, slowly settling as a
> faint ripple spreads. Macro lens, shallow depth of field, slow push-in. Lighting:
> soft key from upper left, deep shadows. Palette: deep navy, emerald green, soft
> white highlights. Mood: calm, premium, technical. Subtle particle whoosh with a
> low ambient synth swell resolving clean. No text, no logos.

## What each slot does

- **Subject** — concrete noun, not a concept. "a brushed-steel orb", not "innovation".
- **Action** — one continuous motion. "slowly rotating", "settling", "drifting".
  Avoid cuts or "then" — that asks for a montage Veo can't do in one clip.
- **Setting** — place + surface + atmosphere (fog, dust motes, water film).
- **Camera move** — pick ONE: slow push-in, slow pull-out, orbit, tilt up,
  locked-off. Multiple moves muddy the result.
- **Lens/lighting** — macro / wide / 35mm; soft key, rim light, volumetric.
- **Palette** — name 2–4 colors. This is the strongest lever for on-brand output.
- **Mood** — calm/premium/tense/playful. Influences pacing + grade.
- **Audio** — Veo 3.1 generates audio. Describe it: "subtle particle whoosh with
  a low ambient synth swell". For silence say "no music, ambient room tone only".
- **Hygiene** — almost always append **"No text, no logos."** Veo loves to
  hallucinate watermarks/captions; this suppresses them.

## Strong levers (biggest quality wins)

1. **Palette naming** — 2–4 named colors beats any adjective.
2. **One camera move** — and name its speed ("slow").
3. **Lighting direction** — "soft key from upper left, deep shadows" reads as
   intentional cinematography.
4. **"No text, no logos"** — removes the most common artifact.
5. **Negative-by-omission** — describe what IS there; don't over-list negatives.

## Orientation

- **Landscape (16:9)** — default for hero/B-roll, web, slides.
- **Portrait (9:16)** — Shorts/Reels/TikTok.
- **Square (1:1)** — feed posts.
Set it on the chip BEFORE Generate; changing it later re-renders.

## Insert vs Extend

- **Insert** — drops the rendered clip onto the timeline as a new scene.
- **Extend** — continues from the END of the current clip (same subject keeps
  moving). Use Extend to lengthen a beat past ~8s; use Insert for a new shot.

## Iterating

- Change ONE slot at a time so you learn what moved the result.
- Keep a winning prompt; fork it for variants (palette swap, camera swap).
- If a clip is close but busy, drop a detail rather than adding one.

## Anti-patterns

- Montages / "then it cuts to…" — generate separate clips instead.
- Reading text on screen ("a sign that says…") — Veo renders garbled text.
- Brand logos — won't be accurate; add real logos in post on the timeline.
- Over-stuffing — 6 competing details average into mush. Pick the 3 that matter.
