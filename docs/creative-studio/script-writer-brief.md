# Script Writer Brief — What the Video Pipeline Needs

**Read this before writing or revising any episode pack.** The renderer turns each
`frames/scene-NN.png` into one ~8-second animated shot, and the ONLY audio in the
finished video is (a) lines the characters speak out loud with lip-sync and (b) soft
background music. There is **no narrator**. Nothing else makes sound.

**The one golden example** — the only series the operator has approved:
`07-breakfast-crew-joke-series/episodes/episode-01-flip-trip/script.md`

Copy its shape. Short episode, every scene voiced, no narrator, the reaction lands after
the joke. A 10-scene episode built the other way was rejected and deleted.

## Episode shape: FOUR scenes

Setup → problem → turn → punchline. About 32 seconds with the reusable intro. Ten-scene
episodes were rejected: no room for a joke, five times the render cost.

## Frames: a different shot every scene

Each `image-prompts.md` frame block must name the **camera, the distance, and who is in
frame**. Wide → close-up → two-shot → low angle. Boilerplate blocks that differ only by a
vague line ("medium character reaction shot") make the image model return the same wide
group shot every time — that reads as one scene repeated, and it got a whole series
scrapped.

**Only characters who speak in a scene may appear in that scene's frame.** A close-up of
one character cannot carry another's line.

## Character descriptions: first clause ends in the character's noun

The renderer identifies a speaker to the video model by the last words of the first clause.
Put props after `with`.

- RIGHT: `Small round bean with two glow sticks; practical and punchy.` → `The bean says:`
- WRONG: `Small bean drummer holding two glow sticks; …` → `The sticks says:` (the
  drumsticks talk)

## The rule that matters most: THE DIALOGUE IS THE STORY

A viewer must be able to follow the whole episode with their eyes closed, from the
characters' spoken lines alone. The frames show it; the characters SAY it.

- **Every scene needs dialogue** — 1 to 3 short lines per scene, roughly 15–20 lines
  across a 10-scene episode. Not 3 lines per episode.
- At most ONE deliberate silent sight-gag scene per episode, if any.
- A scene with no dialogue renders as silent characters drifting to background music.
  Five of those in a row is a screensaver, not a story.

## Pitfalls that have each ruined finished renders

1. **Description is not content.** The episode premise/summary must never appear as a
   speakable row. If it needs to be known, a character says it in their own voice
   ("My pancake flipped right off the plate!"), or the picture shows it. Any prose the
   audio path can see WILL be read aloud by a ghost narrator — banned.
2. **No [VO] rows at all.** The renderer no longer plays them, so anything important
   placed there is silently lost. Don't write them.
3. **Lines max ~10 words.** The video model speaks them in real time; 8 seconds fits
   2–3 short lines. Long lines come out rushed or garbled.
4. **Row order = time order.** A giggle/cheer/reaction row goes AFTER the line it
   reacts to. (A crowd once laughed before the punchline because the reaction row was
   written first.)
5. **Sound words never go in image prompts.** "Rumi Rocket squeaks" in
   `image-prompts.md` produced a frame with a literal "SQUEAK!" speech bubble baked
   in. In frame prompts, describe sound as visible action and facial expression only.
   Sound belongs in [SFX] rows or in dialogue.
6. **Character descriptions: appearance first.** The renderer identifies each speaker
   to the video model by the FIRST clause of their description (up to the first comma
   or semicolon) — e.g. "A warm brown toast slice with a bow tie; proud, a little
   boastful…" → the model hears "the toast slice with the bow tie speaks…". So make
   that first clause purely visual, unique within the cast, and free of personality
   words. Personality goes after the semicolon.
7. **No text anywhere in frames.** Keep the existing "no captions, no speech bubbles,
   no watermark" constraint in every frame prompt, and don't write premises that
   require readable text (signs, labels, written maps) to land.
8. **Tags are strict.** [DIALOGUE] = spoken by that character, [STAGE] = motion only,
   [SFX] = ambient sound hint, [TRANSITION] = edit note. Never put a quoted line in a
   [STAGE] row or a direction inside a [DIALOGUE] line.
9. **NEVER describe what the picture already has — write only how it CHANGES.**
   (Operator rule, 2026-07-07.) The frame image already carries the scenery, the
   characters, the colors, the mood. A [STAGE] row or an `animation.md` Shot Direction
   is a MOTION statement: a subject plus what it does over the 8 seconds.
   - RIGHT: "The spotted lion cub walks across the screen."
   - RIGHT: "The hands on the blue clock tick every second."
   - WRONG: "Establish the creek, a bright jungle stream with mossy stones, giant
     leaves, flower bridges, and firefly lanterns." (That's a description of the
     still image — it directs nothing and confuses the video model.)
   Test each direction: does it contain a VERB of change happening on screen? If you
   removed it, would the shot move differently? If not, cut it.

## What is already perfect — keep exactly as is

- The folder layout (`series/episodes/episode-NN-slug/`), `series-bible.md` with the
  cast table, the reusable `intro/` package.
- `animation.md`'s 10-shot table (`| Time | Start Frame | Tag | Shot Direction |`).
- `image-prompts.md`'s per-frame blocks (subject to pitfall 5 and 7).
- The 6-column dialogue table format:

```
| Time | Frame | Tag | Character | Line | Generator Use |
| --- | --- | --- | --- | --- | --- |
| 0:00-0:05 | `frames/scene-01.png` | [DIALOGUE] | Pippa Pancake | "Watch my best flip ever!" | Character voice. |
| 0:05-0:10 | `frames/scene-02.png` | [DIALOGUE] | Toasty Toast | "You landed on the ceiling." | Character voice. |
| 0:05-0:10 | `frames/scene-02.png` | [STAGE] | - | Everyone giggles. | Animate only. |
```

The `[STAGE]` row sits AFTER the punchline, so the laugh lands after the joke. Note it is
short and it is motion — not a re-description of the frame.

The ONLY change needed in revised packs: **fill that table** — dialogue on every
scene, reactions in the right row positions, no [VO].
