# Kids Video Pipeline — Lessons Learned

Written 2026-07-08 after a bad day: 4 episodes rendered on scripts nobody audited,
a whole batch burned against a dead browser, and a delivery link reported that was
never uploaded. Every line below cost real hours. **Read this before touching a render.**

The one video everyone agrees is good is the **Breakfast Crew** season. Everything
here is either "what Breakfast Crew did" or "what broke when we stopped doing it."

---

## A. THE GATES — never skip these

1. **Audit the script before you spend a render.** Not the format — the *content*.
   Does every scene have spoken dialogue? Is there a narrator row? Are the shot
   directions motion, or are they describing the picture? A pack that parses cleanly
   can still be unwatchable. (Cost: an entire 5-episode series, rendered twice over two
   days, then deleted at the operator's instruction — including everything on Drive.)

2. **Render ONE proof episode, get a verdict, THEN batch.** Unattended batches on
   unproven content just multiply a mistake 25 times.

2b. **When the operator says a story is dead, it is dead.** Do not "fix and continue."
   Stop, delete it, and move to the next story. Rendering a rejected series is the most
   expensive mistake in this document — it wasted two days.

3. **Never report a delivery you did not verify.** Only paste a Drive link that came
   back from the upload call in that same run. The render finishing is not the upload
   finishing. (Cost: a fabricated link, and trust.)

4. **Preflight the browser.** If CDP on :9222 is dead, every render fails in seconds
   and the batch silently eats the whole queue. `ensure-chrome.js` must run first and
   the batch must ABORT — not continue — when it can't bring Chrome up.

5. **Frames are expensive; scripts are cheap.** Rewriting a script costs nothing and
   re-renders no images. So never "just render it and see."

---

## B. THE WRITING — the story lives in the dialogue

6. **NO NARRATOR. EVER.** Not a voice-over, not a `[VO]` row, not a "storyteller."
   The writer's `[VO]` rows were the episode *description*, and the TTS read them
   aloud like a book report. Delete the concept.

7. **Every scene needs spoken dialogue.** 1–3 short lines per scene, ~15–20 lines per
   10-scene episode. Three lines per episode = seven silent scenes = a screensaver.
   Test: could a kid follow the whole story with their eyes closed?

8. **Lines ≤ ~10 words.** Eight seconds fits 2–3 short lines. Longer comes out rushed
   or garbled.

9. **Reactions go AFTER the line they react to.** Row order is time order. A giggle
   row written first makes the crowd laugh before the punchline.

9b. **Four scenes, not ten.** The approved shape (Breakfast Crew, and now Cosmo/Neon/
   Detective/Bubblebop) is a short episode: setup → problem → turn → punchline. A
   10-scene episode was rejected outright — it has no room for a joke and five times the
   render cost.

---

## B2. THE FRAMES — a different shot every scene

9c. **Every frame must be a DIFFERENT SHOT.** Wide, then close-up, then two-shot, then
   low-angle. The writer's original frame prompts were **7 of 9 lines identical
   boilerplate**, differing only in a vague line like "medium character reaction shot,
   surprise but not fear" — so the image model returned the same wide shot of the whole
   cast ten times. The operator's verdict: *"it's just one scene over and over."* Specify
   camera, distance, and who is in frame, per scene.

9d. **Only characters who SPEAK in a scene may be in that scene's frame.** A close-up of
   one character cannot carry another's dialogue — Veo either invents an off-screen voice
   or draws the missing character into the shot.

9e. **A character description's FIRST CLAUSE must end in the character's own noun; props
   go after "with".** The renderer points Veo at a speaker using that clause's last words.
   "Small round bean drummer holding two glow sticks" produced `The sticks says:` — the
   drumsticks would have talked. Write "Small round bean with two glow sticks" → `The bean
   says:`. Check the resolved pointers before rendering.

9f. **The image model draws a white page margin around "wide"/"cinematic" panels** and no
   prompt wording reliably stops it (three attempts). `png-crop.js` finds the artwork's
   bounding box and crops it; it runs automatically inside `frames-08.js` and is
   idempotent on clean frames.

9g. **`qa-frames.js` is a mandatory gate before any Veo spend.** It perceptually hashes
   every frame pair and rejects near-duplicates, and flags white edge bands
   (letterboxing). No episode renders unless it prints `QA_OK`. It passed the good series
   and caught the bad one — this is the "one scene over and over" failure, mechanized.

9h. **A series' `intro/frames/intro-01.png` needs its own manifest entry.** The episode
   stitches `[cached series intro + scenes]`; if the intro frame was never uploaded, the
   render dies with `STORY_ERR frames missing` — pointing at the intro, not the episode.

---

## C. THE PROMPT — the image is the description

10. **NEVER describe what the picture already shows. Direct only what CHANGES.**
    The frame already has the scenery, the characters, the colors, the light.
    - RIGHT: `The spotted lion cub walks across the screen.`
    - RIGHT: `The hands on the blue clock tick every second.`
    - RIGHT: `The man with dark hair moves offscreen fast.`
    - WRONG: `Establish the creek, a bright jungle stream with mossy stones,
      giant leaves, flower bridges, and firefly lanterns.` (that is the still image,
      described back to the model — it directs nothing)
    - WRONG: `Glistening droplets of water swarm as the rain comes down hard.`
    If a sentence has no verb of change, cut it.

11. **Plain verbs. No director-speak, no purple prose.** Say `jumps`, not "bends their
    knees slowly and thrusts upward." Say `it rains`, not "raindrops patter rings
    across the creek and drip from the leaf edges." This is image-gen: keep it easy.

12. **Point, don't name and don't re-describe.** Veo does not know your character's name.
    Use the shortest unique pointer the picture supports: `the astronaut on the right
    says: "..."`. Names produce floating name labels; costume descriptions fight the
    image.

13. **Keep the prompt SHORT.** A wall of rules and negatives makes Veo return
    *"Well, this is unexpected. Something went wrong."* The rules tail must be one
    short line, not a paragraph. Every negative you add is another way to fail.

14. **"Speaking voices only — no singing."** Veo musicalizes exclamatory lines, and a
    song cannot survive the cut between separately generated scenes.

15. **Never put sound words in an image prompt.** "Rumi Rocket squeaks" baked a
    literal `SQUEAK!` speech bubble into the frame. In frame prompts, sound = physical
    action + facial expression. Put the no-text rule LAST — recency beats the
    writer's vivid verbs.

16. **Species nouns and `says:` grammar summon speech bubbles.** The literal word
    "toast" appeared in a drawn bubble. Prefer "speaks aloud"; strip trigger nouns.

---

## D. THE MACHINERY — how it breaks

17. **Retry the SCENE, not the unit.** Veo stalls randomly (a different scene each
    attempt). A unit-level retry re-renders all 10 scenes and usually fails again.
    Per-scene fresh-tab retry (×3) turns a dead episode into a 40-second delay.

18. **Never reuse a launcher filename.** Windows reads a `.cmd` incrementally while
    it runs. Overwriting `launch-08.cmd` mid-run made a live shell execute lines from
    the *next* launch — it rendered the wrong series. Stamp every launcher:
    `launch-<timestamp>.cmd`.

19. **One Chrome, one chain.** Never two render chains at once.

20. **Don't pass `--restore-last-session`** to the video Chrome. It resurrects every
    scene tab from the crashed run (14 stale pages after one restart), bloating the
    CDP target list — which is exactly what makes `connectOverCDP` time out later.

21. **Grab renders by NEW `<video>` src, never by element index.** The Veo panel keeps
    prior renders in the DOM; an index grab re-downloads scene 1 forever.

22. **A fresh project tab per scene.** The reused Veo panel's mode/upload state machine
    is where scene 2+ dies. The rail icon *toggles* the panel; mode switches fail
    silently.

23. **The watcher dedups identical lines.** Repeated `STORY_ERR render timed out` looks
    like silence. Stamp terminal lines uniquely, and poll the log when a unit is
    overdue.

24. **A 401 during precache means the token expired**, not that frames are missing.
    Re-mint (RLS GUCs required) rather than regenerating images.

25. **LAN between ParentPC and the node is firewalled both directions.** Files bridge
    through Drive. Don't retry SMB/HTTP pulls.

---

## E. THE STANDING RULES

- Toma / tortoise-and-hare: **dropped permanently.** Do not touch it.
- Never dub audio over a character's mouth. Veo speaks the dialogue, lip-synced.
- Trims belong to Extend-mode only. Fresh scenes get a 0.45s freeze tail pad instead.
- Voices are stable per character *name* (hash), so a character sounds the same
  across every episode of a series.
