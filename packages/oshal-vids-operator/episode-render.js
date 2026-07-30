'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Node-side renderer for a STORYBOARDED episode (ADR-082 render stage). Was living only as a hand-copied scratch file on the node — versioned here so a node rebuild does not silently break the render stage. Paths now resolve relative to this file instead of a hardcoded absolute repo path.
 */
/**
 * @description Renders one STORYBOARDED episode, on the render node.
 *
 * `dispatchStoryboardedEpisode` (src/app/series-dispatch.ts) invokes this over `shell.exec`, handing
 * it a base64 JSON plan: per scene, the Drive id of its storyboard still and the animation prompt to
 * speak over it. This script never interprets a script — the screenplay-writer wrote it and the
 * controller validated it. It downloads the stills, animates each in Google Vids, stitches them, and
 * saves the episode.
 *
 * Prints exactly one terminal line the controller can trust:
 *   EPISODE_OK  {json}   — carries the Drive link ONLY when the upload actually returned one
 *   EPISODE_ERR message
 *
 * usage: node episode-render.js <base64 plan>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve everything relative to THIS file. The previous version hardcoded the repo's absolute path,
// which meant the script only worked on one machine and broke silently on a rebuilt node.
const PKG = __dirname;
process.env.OSHAL_FFMPEG = process.env.OSHAL_FFMPEG
  || path.join(PKG, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
process.env.VIDS_CDP = process.env.VIDS_CDP || 'http://127.0.0.1:9222';

const { StoryExtendRunner } = require(path.join(PKG, 'src', 'agent', 'story-extend'));
const { concatClips } = require(path.join(PKG, 'src', 'media', 'assemble'));
const store = require(path.join(PKG, 'src', 'storage', 'store'));

/** @description Filesystem-safe slug. @param {string} s text @returns {string} slug */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'episode';

(async () => {
  const raw = process.argv[2];
  if (!raw) { console.log('EPISODE_ERR no plan given'); process.exit(2); }

  let plan;
  try { plan = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  catch (e) { console.log('EPISODE_ERR unreadable plan: ' + e.message); process.exit(2); }

  const { episodeId, title, series, orientation, scenes, introClip } = plan;
  if (!Array.isArray(scenes) || !scenes.length) { console.log('EPISODE_ERR plan has no scenes'); process.exit(2); }
  if (!process.env.VIDS_DRIVE_ACCESS_TOKEN) { console.log('EPISODE_ERR VIDS_DRIVE_ACCESS_TOKEN is not set — cannot fetch the stills'); process.exit(2); }

  const stage = path.join(process.env.VIDS_DATA_DIR || path.join(os.homedir(), '.oshal-vids'), 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const base = `${slug(series)}-${slug(title)}`;

  // Purge this episode's artifacts from any earlier attempt. Scene filenames are deterministic, so a
  // partially-failed run would otherwise leave clips that a later stitch silently mixes in.
  for (const f of fs.readdirSync(stage)) {
    if (f.startsWith(`${base}_scene`) || f === `${base}.mp4`) {
      try { fs.unlinkSync(path.join(stage, f)); } catch { /* in use */ }
    }
  }

  // 1. Fetch the storyboard stills the controller generated (by Drive id — the LAN between the
  //    controller and this node is firewalled both directions).
  const stills = [];
  for (const s of scenes) {
    const dest = path.join(stage, `${base}_still${String(s.n).padStart(2, '0')}.png`);
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${s.frameId}?alt=media`, {
      headers: { authorization: `Bearer ${process.env.VIDS_DRIVE_ACCESS_TOKEN}` },
    });
    if (!res.ok) { console.log(`EPISODE_ERR still ${s.n} download HTTP ${res.status}`); process.exit(1); }
    // eslint-disable-next-line no-await-in-loop
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    stills.push(dest);
  }
  console.log(`[episode] ${scenes.length} stills ready`);

  // 2. Animate each still in Google Vids. The runner opens a fresh project per scene and retries a
  //    STALLED SCENE rather than failing the episode — a unit-level retry re-renders every scene and
  //    every retry is a paid generation.
  const runner = new StoryExtendRunner({ onEvent: (e) => { if (e && e.message) console.log('[episode]', e.message); } });
  const scenesOut = path.join(stage, `${base}-scenes.mp4`);
  const run = await runner.run({
    beats: scenes.map((s) => ({ n: s.n, title: `Scene ${s.n}`, prompt: s.prompt, dialogue: [], narration: null })),
    stills,
    mode: 'storyboard',
    filename: `${base}.mp4`,
    orientation: orientation || 'Landscape',
    narrate: false,          // operator law: the video model speaks the dialogue; nothing is ever dubbed
    tailPadSec: 0.45,
    outFile: scenesOut,
  });
  if (!run.ok) { console.log('EPISODE_ERR ' + run.error); process.exit(1); }

  // 3. Assemble. The show's cached intro goes FIRST when it is present — every episode of a show
  //    opens with the same title sequence, rendered once on 2026-07-08 and reused ever since. A named
  //    intro that is not on this node is skipped loudly rather than failing the episode: the scenes
  //    are already paid for, and a missing title card is not worth throwing them away.
  const clips = [...run.clips];
  if (introClip) {
    const introPath = path.join(stage, String(introClip));
    if (fs.existsSync(introPath)) { clips.unshift(introPath); console.log(`[episode] intro: ${introClip}`); }
    else console.log(`[episode] intro MISSING on this node, continuing without it: ${introClip}`);
  }
  // concatClips fails loud on a missing or truncated clip rather than shipping a short episode as a
  // success.
  const finalOut = path.join(stage, `${base}.mp4`);
  const asm = concatClips(clips, finalOut, { tailPadSec: 0.45 });
  if (!asm.ok) { console.log('EPISODE_ERR assemble: ' + asm.error); process.exit(1); }

  // 4. Save + Drive (store.saveStory uploads when the token is present).
  const saved = await store.saveStory(asm.file, {
    pack: slug(series), id: episodeId, title, moral: '',
    filename: `${base}.mp4`, sceneCount: scenes.length, mode: 'storyboard->veo->assemble',
  });
  if (!saved.ok) { console.log('EPISODE_ERR save: ' + saved.error); process.exit(1); }

  console.log('EPISODE_OK ' + JSON.stringify({
    episodeId,
    localPath: saved.localPath,
    sceneCount: scenes.length,
    bytes: asm.bytes,
    // Never report a delivery the upload call did not actually return.
    driveUrl: saved.drive && saved.drive.webViewLink ? saved.drive.webViewLink : null,
    drivePending: Boolean(saved.drivePending),
  }));
})().catch((e) => { console.log('EPISODE_ERR', e.message); process.exit(1); });
