# Vids production playbook — how to actually BUILD a video, not just one clip

A finished video is a SEQUENCE of shots plus layers (text, music, transitions),
not a single Veo clip. This is the production craft the operator uses to plan and
assemble. Pair it with `veo-prompt-craft.md` (per-clip prompting) and
`vids-ui-runbook.md` (where the buttons are).

## 1. Storyboard first (always plan before clicking)

Turn the idea into a SHOT LIST. A tight promo is usually 3–6 shots × ~8s:

- **Hook** (0–8s) — the strongest single image; stops the scroll.
- **Build** (1–3 shots) — develop the subject / show the value.
- **Payoff / brand** (final shot) — resolve to the logo moment or call-to-action.

For each shot decide: subject + ONE camera move + palette + mood, and how it
CONNECTS to the next (match-cut, continue motion, or hard change). Write it down
before generating — that's the "why" behind every later click.

## 2. Generate each shot (one Veo clip = one continuous ~8s shot)

Never ask one clip to do a montage. Generate shots separately and assemble. Keep
the **palette + lighting consistent across shots** so the promo feels like one
piece (reuse the same palette line in every prompt). Use **Ingredients** (a
reference image, e.g. the logo or a frame) to keep a subject consistent shot to
shot.

## 3. Stitch — Insert vs Extend (the core assembly decision)

- **Insert** = drop the rendered clip onto the timeline as a NEW scene. Use it to
  move from one shot to the next (a cut). This is how you build the sequence.
- **Extend** = continue from the END of the current clip — same subject keeps
  moving past ~8s. Use it to lengthen a single beat (a slow reveal that needs 12s),
  NOT to change shots.
Rule of thumb: new idea → Insert; same idea, more time → Extend.

## 4. Arrange & pace on the timeline

- Order scenes hook → build → payoff by dragging tiles on the timeline strip.
- Trim each scene to its strongest ~4–6s; promos breathe better tight than full-8s.
- Keep total promo length short: 15–30s for social, 6–15s for a bumper.

## 5. Transitions

- Between hard cuts, a quick **dissolve/fade** smooths shots that don't match-cut.
- A **fade from black** in and **to black** out tops and tails the promo cleanly.
- Don't over-transition — most cuts should be straight; reserve dissolves for mood
  or time jumps.

## 6. Layer text (titles, lower-thirds, CTA)

Veo renders garbled text, so NEVER bake words into a clip. Add real text as a
LAYER with the **Text** tool: a title card on the hook, a one-line value prop on a
build shot, a CTA on the payoff. Match the brand font/colors; keep it short and
on screen long enough to read (~2s per 5 words).

## 7. Layer music + audio

- Add a music bed with the **Music** tool; pick a track whose energy matches the
  cut and trim it to the promo length, fading out at the end.
- Veo clips can carry their own generated audio (whooshes, ambience) — duck or mute
  per-clip audio under the music bed so they don't fight.
- Land a beat/hit on the payoff cut for punch.

## 8. "Pan" and motion on stills (Ken Burns)

For a still image (logo, screenshot, photo) that needs life, add it via **Image**
and apply a slow **pan / zoom** (Ken Burns) so it isn't static — a slow push-in on
a logo reads as premium. Use this for brand frames you don't want Veo to
re-interpret. Keep the move slow and single-direction.

## 9. Consistency tricks (make N shots feel like ONE film)

- Repeat the exact **palette** line in every shot's prompt.
- Keep the **same camera-move family** (all slow push-ins, say) for cohesion.
- Feed the **last frame** of a shot as an **Ingredient** to the next for continuity.
- Keep **lighting direction** constant ("soft key from upper left") across shots.

## 10. A promo, end to end (example flow the operator executes)

1. Storyboard: 3 shots + title + CTA + music, one palette.
2. Shot 1 (hook): generate → Insert.
3. Shot 2 (build): generate (same palette) → Insert after shot 1.
4. Shot 3 (payoff, logo): generate or Image+Ken-Burns → Insert.
5. Add a **title** text layer on shot 1; a **CTA** text layer on shot 3.
6. Add a **music** bed, trim to length, fade out; mute clashing clip audio.
7. Add **fade in / fade out** at the ends; quick dissolve on any non-matching cut.
8. Trim each scene tight; reorder if the pacing is off.
9. Play it through; fix the weakest shot by regenerating just that one.

## Anti-patterns
- One mega-prompt trying to be the whole video (it averages to mush — storyboard).
- Baking text/logos into Veo clips (garbled — layer them).
- Extending when you meant a cut (subject drifts — Insert a fresh shot instead).
- Over-long shots and over-transitioning (kills pace).
