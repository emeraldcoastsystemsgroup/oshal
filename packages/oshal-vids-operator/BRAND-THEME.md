# OSHAL Brand Theme & Motion-Graphics Playbook

The validated visual identity for OSHAL motion graphics, plus the production
playbook for reproducing it in Google Vids. Everything here was confirmed in a
live Vids session — it is the source of truth the **marketing-graphics** bot and
`src/brand/graphics.js` are built from. Pair it with the per-clip prompt craft in
`knowledge/veo-prompt-craft.md` and the UI button map in
`knowledge/vids-ui-runbook.md`.

## 1. Visual identity (the OSHAL look)

- **Background:** deep navy.
- **Energy:** glowing electric-blue light; bright white highlights.
- **Signature motion:** a streak / zip of electric light races across the screen
  and **traces out the lowercase wordmark `oshal`** in clean, bright, glowing
  letters. The first letter **`o` ignites as a spinning sphere / orb of light.**
- **Texture:** sparks + particle motion; sleek, modern, cinematic.
- **No flat typed-text overlays** ("no 1980s text boxes"). Add real text only as a
  deliberate layer with the Text tool — never as the brand's default look.
- **Consistency rule:** keep the whole piece ONE theme — fully modern/dynamic OR
  fully retro, **never mixed**.

## 2. Naming & pronunciation

- On-screen wordmark is **lowercase `oshal`**.
- "OSHAL" is pronounced **"Oh-shal."** In any voiceover script, write it as
  **`Oh-shal`** so the TTS engine says it correctly. (`brandVoiceover()` rewrites
  a standalone `oshal` → `Oh-shal` automatically.)

## 3. The tools and what each is for

| Tool | Use it for | Notes |
| --- | --- | --- |
| **Veo** ("Create from scratch") | the abstract brand graphic + the legible `oshal` wordmark | Can spell short lowercase words **only if** the prompt demands the word be "clearly legible and correctly spelled". |
| **Voiceover** | all spoken narration | Pick a voice via **Change the voice** → **Tyra (Clear, medium pitch)** for a confident professional female news-announcer. Script field is a contenteditable: click its area, type, then **Insert voiceover**. |
| **Music** (Lyria 3) | the music bed | Min clip length **30s**. For news pieces use a **serious, authoritative evening-network-news theme** (dramatic strings + driving percussion) — distinctive, **NOT** celebratory / fanfare. |
| **Text** | titles / lower-thirds / CTA | Only when explicitly asked. Never bake words into a Veo clip (except the brand word `oshal`). |

## 4. HARD LIMITS (Veo content filter — design within them)

- **No talking anchor.** Veo REFUSES to generate an on-screen AI person delivering
  scripted / named "news" (deepfake / misinformation filter →
  *"That request looks like it goes against our terms"*), and intermittently
  refuses animating a real person's photo. **Do NOT use Veo to make a talking
  anchor.** Spoken narration goes through the **Voiceover** tool.
- **Filtered spoken words.** Veo's spoken-line filter also blocks the words
  **"dollars"** and **"trades"** and **company names**. For any spoken finance
  content, use **percentages + industry names only**.
- A refusal is a real, reportable outcome — surface it; never fake a clip.

## 5. Reliable automation (CDP)

- Connect to a **debug Chrome over CDP** (`chromium.connectOverCDP` at
  `http://127.0.0.1:9222`) that is already **signed into Google**. Never let
  Playwright launch its own browser (Google blocks those logins).
- **Click via `page.mouse.click` at element `getBoundingClientRect` centers** —
  Google's Vids tiles ignore `el.click()`.
- Uploads (ingredients) go through `page.waitForEvent('filechooser')`.
- Always start from a **fresh editor**: `goto https://docs.google.com/videos/u/0/`
  → click **"Blank video"** → dismiss "Getting started" with **Close**. (Panel
  state is global, so a fresh project avoids carried-over prompts.)
- These primitives live in `src/driver/chrome-cdp.js` (`VidsDriver`) and the
  validated flow in `_build-intro.js`; `src/brand/graphics.js` reuses both.

## 6. Production playbook — the canonical OSHAL intro

The validated "intro clip" is three layers, built in order from a fresh editor:

1. **Electric `oshal` graphic** (Veo, Create from scratch) — `brandGraphicPrompt()`.
   Generate → wait for the real render → **Insert** → close the side sheet.
2. **Voiceover** (optional) — Tyra voice, line run through `brandVoiceover()` so it
   reads "Oh-shal". Insert voiceover.
3. **Music** (optional, default on for an intro) — `brandMusicPrompt()`, the
   serious evening-news theme. Generate → wait → Insert.

Reference prompts (the exact validated strings are in `src/brand/theme.js`):

- **Graphic:** *"A cinematic tech-brand logo animation on a deep navy background:
  a streak of glowing electric-blue energy races across the screen and traces out
  the lowercase word 'oshal' … the first letter o igniting as a spinning sphere of
  light, sparks and particle motion … The word o s h a l must be clearly legible
  and correctly spelled. No other text."*
- **Voiceover (example):** *"The Oh-shal update, with Jamie Lee."* (Tyra)
- **Music:** *"A serious, authoritative evening network-news signature theme:
  dramatic orchestral strings with driving steady percussion … not celebratory, no
  fanfare."*

## 7. How to produce one (code)

```js
const { makeIntro, makeBrandGraphic } = require('./src/brand/graphics');

// Full intro: electric oshal graphic + Tyra voiceover + news music.
const r = await makeIntro({
  subject: 'daily trade recap',
  voiceover: 'The oshal update, with Jamie Lee.', // "oshal" → "Oh-shal" for TTS
  music: true,
});
// r => { ok, url, steps, error?, refused? }

// Silent brand bumper from a brief (graphic only):
const b = await makeBrandGraphic('intro for daily trade recap');
```

In the swarm, the **marketing-graphics** bot calls the same module through the
`brand_graphic` tool (`scripts/oshal-brand.js`) / the worker's `brand.graphic`
tool, and returns the resulting project URL.

## 8. Anti-patterns

- Asking Veo for a talking anchor or a named news read (refused).
- Saying "dollars" / "trades" / a company name in a spoken finance line (filtered).
- Mixing modern and retro looks in one piece (breaks the identity).
- Baking title text into a Veo clip (garbled) — layer it, or keep only the legible
  `oshal` wordmark.
- Faking a clip when a render is refused or times out — report the real reason.
