'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ffmpeg concat helper: normalize + stitch N scene clips into one story MP4 (same imageio_ffmpeg mechanism as the proven daily-recap assemble).
 */
/**
 * @description Stitch N generated scene clips into one continuous story MP4.
 *
 * Downloading a Vids project's full export stalls, so the Extend runner grabs
 * each scene's rendered <video> src individually (reliable) and this module
 * concatenates them locally. Mirrors scripts/assemble-recap.js: resolve ffmpeg,
 * normalize each clip to a uniform track (scale/pad + fps + yuv420p + aac
 * stereo, adding a silent track when a clip has none), then stream-copy concat.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * @description Resolve an ffmpeg executable: OSHAL_FFMPEG env, then the
 * imageio_ffmpeg python-bundled binary (used by the recap), then PATH `ffmpeg`.
 * @returns {string} path to an ffmpeg binary
 */
function resolveFfmpeg() {
  if (process.env.OSHAL_FFMPEG && fs.existsSync(process.env.OSHAL_FFMPEG)) return process.env.OSHAL_FFMPEG;
  try {
    const p = cp.execSync('python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"', { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  return 'ffmpeg'; // assume on PATH
}

/** @description Does a media file carry an audio stream? @param {string} ff ffmpeg path @param {string} file media path @returns {boolean} true if audio present */
function hasAudio(ff, file) {
  const r = cp.spawnSync(ff, ['-i', file], { encoding: 'utf8' });
  return /Audio:/.test((r.stderr || '') + (r.stdout || ''));
}

/**
 * @description Normalize + concat scene clips into one MP4.
 *
 * Overlap trim (v2, operator-observed 2026-07-06): a Veo EXTEND clip begins with
 * ~0.25s of the previous clip's tail (its conditioning lead-in), so a butt-joint
 * concat double-plays that sliver at every cut. `opts.trimHeads[i]` marks clips
 * whose head must be trimmed by `opts.headTrimMs` (default 250, env
 * VIDS_EXTEND_OVERLAP_MS). The trim is an accurate output-side seek (after -i),
 * exact because every clip is re-encoded during normalize anyway.
 *
 * @param {string[]} clips ordered absolute paths of the scene MP4s
 * @param {string} outFile absolute output path for the stitched story
 * @param {{width?:number,height?:number,fps?:number,keepSegments?:boolean,headTrimMs?:number,trimHeads?:boolean[]}} [opts] geometry + overlap-trim + cleanup options
 * @returns {{ok:boolean,file?:string,bytes?:number,error?:string}} result
 */
function concatClips(clips, outFile, opts = {}) {
  // FAIL LOUD on a missing/truncated input. Silently dropping one produced a SHORT
  // episode that still returned ok:true and was uploaded as a success (found by the
  // 2026-07-08 pipeline review). Callers wanting best-effort pass opts.allowMissing.
  const requested = (clips || []).filter(Boolean);
  const bad = requested.filter((c) => !fs.existsSync(c) || fs.statSync(c).size <= 1000);
  if (bad.length && !opts.allowMissing) {
    return { ok: false, error: `${bad.length} missing/truncated input clip(s): ${bad.map((b) => path.basename(b)).join(', ')}` };
  }
  const list = requested.filter((c) => fs.existsSync(c) && fs.statSync(c).size > 1000);
  if (!list.length) return { ok: false, error: 'no valid input clips to concat' };
  // Single-clip copy shortcut only when there's nothing to mix in.
  if (list.length === 1 && !(Array.isArray(opts.narrations) && opts.narrations.some(Boolean))) {
    fs.copyFileSync(list[0], outFile);
    return { ok: true, file: outFile, bytes: fs.statSync(outFile).size };
  }

  const ff = resolveFfmpeg();
  const W = opts.width || 1280;
  const H = opts.height || 720;
  const FPS = opts.fps || 24;
  const pad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
  const dir = path.dirname(outFile);
  const headTrimMs = opts.headTrimMs != null ? Number(opts.headTrimMs) : Number(process.env.VIDS_EXTEND_OVERLAP_MS || 250);
  const trimHeads = Array.isArray(opts.trimHeads) ? opts.trimHeads : [];
  // Deterministic narration overlay (v5/v7): per-clip narration spoken by OUR narrator.
  // Entries are `{file, atMs}` (or a bare path = atMs 400). v7 windowed ducking: the
  // clip audio (which now carries the AUTHORED DIALOGUE) is ducked ONLY while the
  // narrator speaks — never flattening dialogue outside the narration window.
  const narrations = Array.isArray(opts.narrations) ? opts.narrations : [];
  const duck = opts.duckTo != null ? Number(opts.duckTo) : Number(process.env.VIDS_DUCK_CLIP_AUDIO || 0.25);
  /** duration (s) of an audio file via ffmpeg -i stderr; 0 if unknown */
  const audioDur = (file) => {
    const r = cp.spawnSync(ff, ['-i', file], { encoding: 'utf8' });
    const m = ((r.stderr || '') + (r.stdout || '')).match(/Duration: (\d+):(\d+):([\d.]+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  };
  const segs = [];
  try {
    list.forEach((clip, i) => {
      const seg = path.join(dir, `_seg_${i}.mp4`);
      // Accurate head trim for extend lead-in overlap: -ss AFTER the input.
      const trim = trimHeads[i] && headTrimMs > 0 ? ['-ss', (headTrimMs / 1000).toFixed(3)] : [];
      const rawNarr = narrations[i];
      // v8: an ARRAY of {file, atMs} events = the scene's FULL local soundtrack
      // (character dialogue + narrator). Clip audio is discarded or heavily ducked
      // (opts.clipAudio: 'drop' | 'bed') — Veo can voice prompt text, so its track
      // is never trusted with speech.
      if (Array.isArray(rawNarr)) {
        const events = rawNarr.filter((e) => e && e.file && fs.existsSync(e.file));
        const useBed = opts.clipAudio !== 'drop' && hasAudio(ff, clip);
        // Every audio stream in the graph must be FINITE — apad/anullsrc-into-amix
        // never terminates (hung the first smoke even with -shortest).
        // NEVER cut speech at the scene boundary (operator: "every clip narration was
        // cut off"): if the scene's audio events outlast the clip, FREEZE the last
        // video frame (tpad clone) until the audio finishes + a small tail. No
        // trimming in this strategy — trims exist only for Extend-mode overlaps.
        const vidDur = Math.max(1, audioDur(clip) || 8);
        const lastEndMs = events.reduce((mx, e) => Math.max(mx, Math.round(e.atMs || 0) + Math.round(audioDur(e.file) * 1000)), 0);
        const needDur = Math.max(vidDur, lastEndMs / 1000 + 0.4);
        const holdSec = Math.max(0, needDur - vidDur);
        const inputs = ['-y', '-i', clip];
        events.forEach((e) => inputs.push('-i', e.file));
        const vchain = holdSec > 0.05
          ? `[0:v]${pad},tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}[v]`
          : `[0:v]${pad}[v]`;
        const chains = [vchain];
        const mixIns = [];
        if (useBed) { chains.push(`[0:a]volume=${duck},apad,atrim=0:${needDur.toFixed(3)}[bg]`); }
        else { chains.push(`anullsrc=r=48000:cl=stereo,atrim=0:${needDur.toFixed(3)}[bg]`); }
        mixIns.push('[bg]');
        events.forEach((e, k) => {
          const at = Math.max(0, Math.round(e.atMs || 0));
          chains.push(`[${k + 1}:a]adelay=${at}|${at},aformat=sample_rates=48000:channel_layouts=stereo[s${k}]`);
          mixIns.push(`[s${k}]`);
        });
        let mixedRef;
        if (mixIns.length === 1) {
          mixedRef = '[bg]';
        } else {
          chains.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0,volume=${Math.min(2, 1 + 0.35 * (mixIns.length - 1)).toFixed(2)}[mixed]`);
          mixedRef = '[mixed]';
        }
        const args2 = [...inputs, ...trim, '-filter_complex', chains.join(';'),
          '-map', '[v]', '-map', mixedRef,
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', seg];
        const r2 = cp.spawnSync(ff, args2, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 180000 });
        if (r2.status !== 0) throw new Error(`normalize clip ${i} failed: ${(r2.stderr || '').slice(-300)}`);
        segs.push(seg);
        return;
      }
      const narrFile = rawNarr && (typeof rawNarr === 'string' ? rawNarr : rawNarr.file);
      const narr = narrFile && fs.existsSync(narrFile) ? narrFile : null;
      const atMs = narr ? Math.max(0, Number(typeof rawNarr === 'object' ? rawNarr.atMs : 400) || 400) : 0;
      let args;
      if (narr && hasAudio(ff, clip)) {
        // Windowed duck: the clip bed drops to `duck` ONLY while the narrator speaks
        // (atMs .. atMs+narration duration+0.3s), so in-clip Veo dialogue outside the
        // window stays at full level. If the narration outlasts the clip, FREEZE the
        // last frame until it finishes — never cut speech at the boundary.
        // NOTE: -vf cannot coexist with -filter_complex — the video pad lives in the graph.
        const nDur = audioDur(narr);
        const atS = (atMs / 1000).toFixed(3);
        const endS = (atMs / 1000 + nDur + 0.3).toFixed(3);
        const vDur = Math.max(1, audioDur(clip) || 8);
        const needDur = Math.max(vDur, atMs / 1000 + nDur + 0.4);
        const holdSec = Math.max(0, needDur - vDur);
        const vchain = holdSec > 0.05 ? `[0:v]${pad},tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}[v]` : `[0:v]${pad}[v]`;
        args = ['-y', '-i', clip, '-i', narr, ...trim,
          '-filter_complex',
          `${vchain};[0:a]volume=${duck}:enable='between(t,${atS},${endS})',apad,atrim=0:${needDur.toFixed(3)}[bg];[1:a]adelay=${atMs}|${atMs},aformat=sample_rates=48000:channel_layouts=stereo[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=0,volume=1.6[mixed]`,
          '-map', '[v]', '-map', '[mixed]',
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', seg];
      } else if (narr) {
        // narration is the only audio (silent clip): pad it to the video length.
        args = ['-y', '-i', clip, '-i', narr, ...trim,
          '-filter_complex',
          `[0:v]${pad}[v];[1:a]adelay=${atMs}|${atMs},apad,aformat=sample_rates=48000:channel_layouts=stereo[vo]`,
          '-map', '[v]', '-map', '[vo]', '-shortest',
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', seg];
      } else if (hasAudio(ff, clip)) {
        // Optional breathing room between scenes: freeze-hold the last frame for
        // tailPadSec (operator: dialogue running to the 8s boundary reads as a cut).
        const tailPad = Math.max(0, Number(opts.tailPadSec || 0));
        const vf = tailPad > 0.05 ? `${pad},tpad=stop_mode=clone:stop_duration=${tailPad.toFixed(3)}` : pad;
        const af = tailPad > 0.05 ? 'aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=' + tailPad.toFixed(3) : 'aformat=sample_rates=48000:channel_layouts=stereo';
        args = ['-y', '-i', clip, ...trim, '-vf', vf, '-af', af,
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', seg];
      } else {
        args = ['-y', '-i', clip, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', ...trim, '-vf', pad,
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', '-shortest', seg];
      }
      // Every ffmpeg spawn is bounded — a wedged encoder would otherwise hang the whole
      // unattended batch forever (2026-07-08 review).
      const r = cp.spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 180000, killSignal: 'SIGKILL' });
      if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`normalize clip ${i} timed out after 180s`);
      if (r.status !== 0) throw new Error(`normalize clip ${i} failed: ${(r.stderr || '').slice(-300)}`);
      segs.push(seg);
    });

    const listFile = path.join(dir, `_concat_${Date.now().toString(36)}.txt`);
    fs.writeFileSync(listFile, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
    const r = cp.spawnSync(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 600000, killSignal: 'SIGKILL' });
    fs.rmSync(listFile, { force: true });
    if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('final concat timed out after 600s');
    if (r.status !== 0) throw new Error(`concat failed: ${(r.stderr || '').slice(-300)}`);
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 10000) throw new Error('concat produced a missing/tiny file');
    return { ok: true, file: outFile, bytes: fs.statSync(outFile).size };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (!opts.keepSegments) for (const s of segs) fs.rmSync(s, { force: true });
  }
}

/**
 * @description Extract one frame from a clip as PNG — the HERO FRAME for the
 * storyboard (I2V) mode: scene 1's world+characters become the image anchor
 * every later scene animates from (beats extension drift, which accumulates).
 * @param {string} file source clip
 * @param {string} outPng destination PNG path
 * @param {number} [atSec] timestamp to grab (default 4s — mid-clip, characters settled)
 * @returns {{ok:boolean,file?:string,error?:string}} result
 */
function extractFrame(file, outPng, atSec = 4) {
  if (!fs.existsSync(file)) return { ok: false, error: `clip not found: ${file}` };
  const ff = resolveFfmpeg();
  const r = cp.spawnSync(ff, ['-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', outPng], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0 || !fs.existsSync(outPng)) return { ok: false, error: `frame extract failed: ${(r.stderr || '').slice(-200)}` };
  return { ok: true, file: outPng };
}

module.exports = { resolveFfmpeg, concatClips, hasAudio, extractFrame };
