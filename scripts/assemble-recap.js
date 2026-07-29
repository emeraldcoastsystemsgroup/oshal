/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial 5-scene assemble with words/20 pacing stretch
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stop slow-motioning Veo clips: they are self-paced (one generated clip, audio+video intrinsically synced), so the words/20 setpts stretch just played the operator in slow-mo (intro 1.70x). Stretch was for the retired edge-tts-dub flow. Drop it (stretch=1.0) for the Veo the operator clips.
 */
/* assemble-recap.js — stitch the 5-scene daily recap.
 * intro -> OSHAL sting -> overview -> deck -> close. Two-step: normalize each scene to
 * 1280x720/24fps/yuv420p + aac48k stereo, then concat. Google/Veo-made only. Veo clips are
 * NOT time-stretched — each is a single self-paced generation whose audio and video already
 * match, so a setpts/atempo stretch only slows the speaker down. (The old words/20 pacing
 * stretch existed for the retired edge-tts-dub-over-clip flow; it does not apply here.)
 */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const OUT = process.env.OSHAL_RECAP_OUT || 'C:\\Projects\\open-shal-swarm-harness-agent-llm\\packages\\oshal-vids-operator\\out';
const FF = cp.execSync('python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"').toString().trim();
const W = 1280, H = 720, FPS = 24;
const PAD = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
const clamp = (x) => Math.max(1.0, Math.min(2.0, x));

// Scenes in order. words:0 => stretch 1.0 (natural speed). Every clip here is Veo/Google-made
// and self-paced, so NONE are stretched — a nonzero words count would slow the speaker down.
const scenes = [
  { f: path.join(OUT, 'presenter-intro.mp4'), words: 0 },         // Veo clip — self-paced, no stretch
  { f: path.join(OUT, 'brand', 'oshal.mp4'), words: 0 },          // sting (music) — no stretch
  { f: path.join(OUT, 'presenter-overview.mp4'), words: 0 },      // Veo clip — self-paced, no stretch
  { f: path.join(OUT, 'deck-narrated.mp4'), words: 0 },           // Google Convert-Slides narrated deck (has its own VO+music)
  { f: path.join(OUT, 'presenter-close.mp4'), words: 0 },         // Veo clip — self-paced, no stretch
];

function ff(args) {
  const r = cp.spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { console.error('FFMPEG FAIL:', (r.stderr || '').slice(-900)); process.exit(1); }
}
function hasAudio(file) {
  const r = cp.spawnSync(FF, ['-i', file], { encoding: 'utf8' });
  return /Audio:/.test((r.stderr || '') + (r.stdout || ''));
}

const segs = [];
scenes.forEach((s, i) => {
  if (!fs.existsSync(s.f)) { console.error('MISSING', s.f); process.exit(1); }
  const seg = path.join(OUT, `rseg_${i}.mp4`);
  const S = s.words ? clamp(s.words / 20) : 1.0;
  const audio = !s.silent && hasAudio(s.f);
  let args;
  if (audio) {
    const vf = S === 1.0 ? PAD : `setpts=${S}*PTS,${PAD}`;
    const af = S === 1.0 ? 'aformat=sample_rates=48000:channel_layouts=stereo'
      : `atempo=${(1 / S).toFixed(4)},aformat=sample_rates=48000:channel_layouts=stereo`;
    args = ['-y', '-i', s.f, '-vf', vf, '-af', af, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', seg];
  } else {
    // no/ignored audio -> add silent stereo track (keeps concat uniform)
    args = ['-y', '-i', s.f, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-vf', PAD,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', '-shortest', seg];
  }
  console.log(`seg ${i}: ${path.basename(s.f)}  stretch=${S.toFixed(2)}  ${audio ? 'audio' : 'silent'}`);
  ff(args);
  segs.push(seg);
});

const list = path.join(OUT, 'rlist.txt');
fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
const final = path.join(OUT, 'trade-recap.mp4');
ff(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);
const dur = cp.spawnSync(FF, ['-i', final], { encoding: 'utf8' }).stderr.match(/Duration: ([\d:.]+)/);
console.log('ASSEMBLED', final, Math.round(fs.statSync(final).size / 1024) + 'KB', dur ? dur[1] : '');
