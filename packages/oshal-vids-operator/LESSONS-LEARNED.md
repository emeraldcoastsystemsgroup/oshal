# Vids Operator Lessons Learned

These are the operational rules from the live runs. Read this before generating,
assembling, or publishing video.

## Prompting

- Describe motion, actions, timing, and spoken lines. Do not spend the prompt
  describing what is already visible in the uploaded still.
- For image-to-video, the image carries appearance. The prompt should say what
  moves next: looks at camera, raises hand, turns left, smiles, points, speaks a
  specific short line.
- Use short pointer grammar for characters. Say "the astronaut says..." or "the
  toast jumps..." instead of long costume descriptions or character names.
- Names and rich descriptions can create labels, text artifacts, wrong speakers,
  or new characters. Keep the prompt plain and physical.
- Never ask Veo to render text, subtitles, logos, name labels, signs, or speech
  bubbles. Add real text later as a layer.
- For the operator/trade recap clips, include the exact voice directive:
  `use Nyx / Clear, lower middle pitch voice`.
- Keep spoken lines short. About 20 words per 8-second host clip is the target;
  40 words is the hard cap.

## Google Vids Flow

- Fresh video per clip. New tab, new blank video, new Veo render. Do not build
  all host clips in one big Vids project.
- Keep one keeper tab open so the debug Chrome profile does not die when a clip
  tab closes.
- Switch to "Animate an image" before setting the image. Then set the hidden
  file input directly. Do not open the native Windows file picker.
- A clip is not real until the UI shows a duration badge, usually `0:08`.
- Download discipline matters: start the download, wait for the file to exist on
  disk, then close only that clip tab.
- If Chrome/CDP is bloated or stalls, restart only the dedicated
  `oshal-video-chrome` profile. Do not touch the user's main browser.

## Render Capture

- Grab generated clips by new video `src`, not by element index. The panel keeps
  old generated videos in the DOM.
- Exclude Google inspiration/gallery clips. They are not our render.
- For story mode, fresh-tab per scene is more reliable than reusing a mutated
  panel state machine.
- If a scene stalls or is refused, retry that scene in a fresh tab before failing
  the whole unit.

## Publishing

- Do not mass publish from `out/` blindly. `out/` can contain stale videos,
  partial dry runs, and decks from a newer date than the MP4.
- Before publishing, verify the triad matches one date:
  `deck-data.json` date, `trade-recap.mp4` timestamp/content, and
  `YYYY-MM-DD.pdf`.
- If `deck-data.json` says July 7 but `trade-recap.mp4` is still July 6, stop.
  That is stale media, not a publishable recap.
- Never publish a video whose headline numbers disagree with `deck-data.json`.
- Never claim publish success without a prod 200 for the dated MP4 and an
  `index.json` whose first entry is the same date.
- Drive upload is a delivery path, not proof of correctness. The local manifest
  and final dated artifacts still need validation.

## Recovery

- A clean stop with a real `recap-agent.err` is better than a bad recap.
- Do not use deterministic fallback clips for the operator when the SOP calls for
  fresh Vids clips. Stale host clips with new data are a trust failure.
- If a tool or browser workflow is too slow, reduce the task to the next verifiable
  artifact rather than pretending the full chain is done.
