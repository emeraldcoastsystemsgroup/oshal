# Google Vids UI runbook (how the operator drives it)

This is the operational map the bot uses to reason about clicks. The actual step
list lives in `recipes/google-vids.yaml`; this explains the surface so the vision
fallback can recover when labels move.

## Layout (as of the editor we target)

- **Top menu**: File, Edit, View, Scene, Arrange, Tools, Help. Play / Share top-right.
- **Left canvas**: the current scene preview + a timeline strip along the bottom
  with a "+" to add scenes.
- **Right rail (vertical icons)**: Veo, Avatar, Voiceover, Music, Image, Record,
  Uploads, Stock, Captions, Text, Templates, Shapes. **Veo** opens AI video clip.
- **AI video clip panel** (opens from Veo): a model dropdown (e.g. "Veo 3.1"), a
  "Create from scratch" dropdown, a prompt textarea, an orientation chip
  ("Landscape"), **Avatar** and **Ingredients** buttons, and a blue **Generate**.
- **Result card** (after generation): a thumbnail with a duration badge (e.g.
  "0:08"), and **Insert** / **Extend** controls (a ⋮ menu has more).

## Canonical generate flow

1. Click the **Veo** rail icon → the "AI video clip" panel opens.
2. Ensure the mode dropdown reads **Create from scratch**.
3. Click the prompt box and type the Veo prompt.
4. Click the orientation chip and pick **Landscape / Portrait / Square**.
5. (Optional) Click **Ingredients** → choose an image/video to condition the clip.
6. Click **Generate**. A result card appears after the render (seconds to minutes).
7. Read the duration badge to confirm a real clip rendered.
8. Click **Insert** (new scene) or **Extend** (continue the current clip).

## Animate an image (talking-host clips) — the proven fast path

The most reliable way to make a talking host is to animate a single still:

1. Click the **Veo** rail icon → the "AI video clip" panel opens.
2. In the mode dropdown (default **Create from scratch**), choose **Animate an image**.
3. Click **Ingredients** (or **Add image**) → in the file picker, type the full
   path to the still and press Enter.
4. In the prompt box, type the **motion + the spoken line together**, e.g.
   `The host looks at the camera and speaks naturally… The host says: "<line>"`.
   Keep the spoken line short; longer scripts can be split across clips.
5. Set orientation (Portrait for Shorts/Reels, Landscape otherwise).
6. **Generate**, wait for the duration badge, then **Insert**.
7. (Optional) **Captions** rail → auto-captions to subtitle the spoken line.

Reuse ONE avatar still across videos so the host stays consistent and you never
re-train an avatar. The scenario library (`recipes/scenarios.yaml`) pins all of
the above per use-case (stock-picks, llm-overview, …) so the operator runs a
fixed checklist instead of re-deriving these clicks each time.

## Adding inputs (photos / videos)

- **Ingredients** conditions the generation on a reference image/video (style,
  subject, first frame). Use it when the operator supplies an input asset.
- **Uploads** (rail) brings an asset onto the timeline directly (not generation).

## Assembling a multi-shot video

- Each Generate → Insert adds one scene. Build a sequence by generating several
  clips (vary the prompt per shot) and Inserting them in order.
- Use the timeline "+" to add scenes; drag to reorder (post-MVP for the driver).
- Add real logos/text/music with the Text / Image / Music rail tools AFTER the
  AI clips are placed — never ask Veo to render brand text.

## Selector hygiene (for self-healing)

- Prefer **visible label text** ("Generate", "Insert", "Landscape") as targets;
  Google's class names are obfuscated and churn.
- The Veo panel is the same surface whether reached via the rail icon or the
  Insert menu — `ensure` steps are idempotent (skip if already open).
- After a UI change, the vision fallback picks the closest label and the engine
  records it back into the recipe, so the next run is fast again.
