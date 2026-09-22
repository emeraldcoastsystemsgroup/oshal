'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Node-side SEASON stitch: concatenate a finished series' episodes, in ordinal order, into one season cut and validate the result's streams before reporting it. The pipeline could assemble an episode but never a season, so a multi-episode series ended as a pile of separate files with nothing to watch end to end.
 */
/**
 * @description Stitches one SERIES into a season cut, on the render node.
 *
 * `dispatchSeasonAssembly` (src/app/series-dispatch.ts) invokes this over `shell.exec` with a
 * base64 JSON plan: the series, and its finished episodes with their ordinals and paths. It runs
 * here, not on the controller, because the episode files are already here — shipping hundreds of
 * megabytes back just to concatenate them would be a pointless round trip.
 *
 * Two properties are the whole point of this script:
 *
 *   ORDER IS THE ORDINAL. The plan arrives sorted, and it is sorted AGAIN here by ordinal before
 *   anything is stitched. A season whose episodes play out of order is not a smaller defect than a
 *   season that failed to build; it is a worse one, because it looks finished.
 *
 *   THE OUTPUT IS READ BACK. `concatClips` fails loud on a missing or truncated INPUT, but nothing
 *   ever looked at the RESULT. A season cut that is silent, pictureless, or far shorter than the
 *   episodes that went into it is reported as a failure here rather than uploaded as a success.
 *
 * Prints exactly one terminal line the controller can trust:
 *   SEASON_OK  {json}   — carries the Drive link ONLY when the upload actually returned one
 *   SEASON_ERR message
 *
 * usage: node season-assemble.js <base64 plan>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG = __dirname;
process.env.OSHAL_FFMPEG = process.env.OSHAL_FFMPEG
  || path.join(PKG, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const { concatClips, probeStreams } = require(path.join(PKG, 'src', 'media', 'assemble'));
const store = require(path.join(PKG, 'src', 'storage', 'store'));

/** How much shorter than the sum of its episodes a season cut may be before it is a truncation. */
const MIN_DURATION_RATIO = 0.9;

/** @description Filesystem-safe slug. @param {string} s text @returns {string} slug */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'season';

/**
 * @description Put the episodes in the only order a season may play in, and refuse a plan that
 * cannot name that order. A duplicate ordinal means two episodes claim the same slot, which is an
 * ambiguity the stitch must not resolve by guessing.
 * @param {Array<{ordinal:number,title:string,path:string}>} episodes the plan's episodes
 * @returns {{ok:boolean, episodes?:Array<object>, error?:string}} the ordered episodes, or why not
 */
function inOrdinalOrder(episodes) {
  if (!Array.isArray(episodes) || episodes.length < 2) {
    return { ok: false, error: `a season needs at least 2 episodes, got ${Array.isArray(episodes) ? episodes.length : 0}` };
  }
  const ordinals = episodes.map((e) => Number(e.ordinal));
  if (ordinals.some((n) => !Number.isFinite(n))) return { ok: false, error: 'every episode needs a numeric ordinal' };
  if (new Set(ordinals).size !== ordinals.length) {
    return { ok: false, error: `duplicate episode ordinals: ${ordinals.join(', ')}` };
  }
  return { ok: true, episodes: [...episodes].sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) };
}

/**
 * @description Read every episode BEFORE the stitch: each must actually carry picture, and their
 * durations are what the finished cut is measured against. Checked first because a normalize +
 * concat over an episode that is not a video is minutes of work to reach a failure ffmpeg could
 * state in milliseconds.
 * @param {string[]} inputs the episode files, in play order
 * @returns {{ok:boolean, seconds?:number, error?:string}} the expected running time, or why not
 */
function expectedSeconds(inputs) {
  let total = 0;
  for (const f of inputs) {
    const p = probeStreams(f);
    if (p.error) return { ok: false, error: `episode unreadable: ${path.basename(f)} — ${p.error}` };
    if (!p.video) return { ok: false, error: `episode has no video stream: ${path.basename(f)}` };
    total += p.seconds;
  }
  return { ok: true, seconds: total };
}

/**
 * @description Read back what the stitch ACTUALLY produced. A stitch is only a success when the
 * file plays: picture, sound, and roughly the running time of what went into it. Without this a
 * silent, pictureless or half-length season cut is uploaded and recorded as a finished series.
 * @param {string} outFile the finished season cut
 * @param {number} expected the summed duration of the episodes
 * @returns {{ok:boolean, seconds?:number, error?:string}} the verdict
 */
function validateOutput(outFile, expected) {
  const out = probeStreams(outFile);
  if (out.error) return { ok: false, error: `season cut unreadable: ${out.error}` };
  if (!out.video) return { ok: false, error: 'season cut has no video stream' };
  if (!out.audio) return { ok: false, error: 'season cut has no audio stream' };
  if (out.seconds <= 0) return { ok: false, error: 'season cut has no duration' };
  if (expected > 0 && out.seconds < expected * MIN_DURATION_RATIO) {
    return { ok: false, error: `season cut is truncated: ${out.seconds.toFixed(2)}s of an expected ${expected.toFixed(2)}s` };
  }
  return { ok: true, seconds: out.seconds };
}

(async () => {
  const raw = process.argv[2];
  if (!raw) { console.log('SEASON_ERR no plan given'); process.exit(2); }

  let plan;
  try { plan = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
  catch (e) { console.log('SEASON_ERR unreadable plan: ' + e.message); process.exit(2); }

  const { seriesId, title } = plan;
  if (!seriesId || !title) { console.log('SEASON_ERR plan needs seriesId and title'); process.exit(2); }

  const ordered = inOrdinalOrder(plan.episodes);
  if (!ordered.ok) { console.log('SEASON_ERR ' + ordered.error); process.exit(2); }

  const inputs = ordered.episodes.map((e) => String(e.path));
  const missing = inputs.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.log(`SEASON_ERR ${missing.length} episode file(s) missing on this node: ${missing.map((f) => path.basename(f)).join(', ')}`);
    process.exit(1);
  }
  for (const e of ordered.episodes) console.log(`[season] ${e.ordinal}. ${e.title}`);

  const stage = path.join(process.env.VIDS_DATA_DIR || path.join(os.homedir(), '.oshal-vids'), 'stage');
  fs.mkdirSync(stage, { recursive: true });
  const base = `${slug(title)}-season`;
  const outFile = path.join(stage, `${base}.mp4`);
  try { fs.unlinkSync(outFile); } catch { /* no earlier attempt */ }

  const expected = expectedSeconds(inputs);
  if (!expected.ok) { console.log('SEASON_ERR ' + expected.error); process.exit(1); }

  // concatClips normalizes each episode to one uniform track (adding a silent audio track to any
  // episode that has none) before the stream-copy concat, which is why a season cut always carries
  // audio even when one episode did not.
  const asm = concatClips(inputs, outFile);
  if (!asm.ok) { console.log('SEASON_ERR assemble: ' + asm.error); process.exit(1); }

  const verdict = validateOutput(asm.file, expected.seconds);
  if (!verdict.ok) { console.log('SEASON_ERR ' + verdict.error); process.exit(1); }

  const saved = await store.saveStory(asm.file, {
    pack: slug(plan.series || title), id: seriesId, title: `${title} — season`, moral: '',
    filename: `${base}.mp4`, sceneCount: inputs.length, mode: 'season',
  });
  if (!saved.ok) { console.log('SEASON_ERR save: ' + saved.error); process.exit(1); }

  console.log('SEASON_OK ' + JSON.stringify({
    seriesId,
    localPath: saved.localPath,
    episodeCount: inputs.length,
    seconds: Number(verdict.seconds.toFixed(2)),
    bytes: asm.bytes,
    // Never report a delivery the upload call did not actually return.
    driveUrl: saved.drive && saved.drive.webViewLink ? saved.drive.webViewLink : null,
    drivePending: Boolean(saved.drivePending),
  }));
})().catch((e) => { console.log('SEASON_ERR', e.message); process.exit(1); });
