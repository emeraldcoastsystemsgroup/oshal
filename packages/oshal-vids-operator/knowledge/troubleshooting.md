# Troubleshooting

## "No Google Vids tab found"
The driver attaches to YOUR Chrome and only drives a tab whose URL looks like the
Vids editor (`docs.google.com/videos/...`). Fix: open your Vids project in the
debug Chrome (the one launched by `npx oshal-vids chrome`), then retry connect.

## "Could not attach to Chrome at http://localhost:9222"
Chrome isn't running with the debug port. Launch it with `npx oshal-vids chrome`
(or set `VIDS_CDP_URL` to your debug endpoint). The everyday Chrome won't work —
it needs `--remote-debugging-port`.

## A step times out / "Could not find target"
Google moved or renamed the control. With the bot loaded, the vision fallback
reads the page's visible labels and recovers; without it, the step surfaces a real
error (we never fake a click). Update the label in `recipes/google-vids.yaml` if a
control was renamed for good.

## Generation never finishes (wait-render times out)
- Veo can take seconds to minutes; raise `defaults.generateTimeoutMs` in the recipe.
- A failed render shows an error toast, not a duration badge — that's a real Veo
  failure, not a driver bug. Re-queue with a simpler prompt.
- Free generation is rate-limited; pace jobs. Repeated immediate failures usually
  mean you've hit a quota — wait and retry.

## Clip looks wrong
See `veo-prompt-craft.md`. Most fixes: name a palette, pick ONE camera move, add
"No text, no logos", and drop a competing detail rather than adding more.

## Garbled text / fake watermark in the clip
Veo renders on-screen text poorly. Don't ask for readable text or logos in the
prompt — add real text/logos on the timeline afterward with the Text/Image tools.

## The bot says it can't reach Codex
The packed bot shells out to the `codex` CLI. Install + log in:
`npm i -g @openai/codex` then `codex login`. Set `CODEX_CLI_PATH` if it's not on
PATH. Without it the panel still runs in recipe-only mode.

## Vision fallback isn't picking the right control
It chooses from visible labels; if the right control has no text label (icon-only)
it may miss. Add an explicit `target`/`altTargets` selector for that step in the
recipe so it doesn't depend on the fallback.
