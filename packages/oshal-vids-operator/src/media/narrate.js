'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic narration: synth each beat's script text locally (Edge neural TTS, Windows SAPI fallback) so the story's WORDS are guaranteed — Veo's in-clip speech is a per-clip roulette (audio present but wrong/garbled words made the v4a story unintelligible).
 */
/**
 * @description Local narration synthesis for story videos.
 *
 * The narrator track is the story. Veo renders beautiful consistent pictures
 * (v4a) but its generated speech is unreliable — so the pipeline speaks the
 * pack's actual script itself, one consistent voice, perfectly paced, and mixes
 * it over the animation at the stitch (clip audio ducked to an ambience bed).
 *
 * Engines, in order:
 *   1. msedge-tts (Edge neural voices, needs network) — warm storyteller quality.
 *      Voice via VIDS_NARRATOR_TTS_VOICE (default en-US-JennyNeural; try
 *      en-US-AnaNeural for a younger storybook feel).
 *   2. Windows SAPI (System.Speech via PowerShell) — offline, always available
 *      on the render node; plainer voice but never fails silently.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_VOICE = process.env.VIDS_NARRATOR_TTS_VOICE || 'en-US-JennyNeural';
// Distinct Edge neural voices for CHARACTER dialogue (v8: ALL speech is local — Veo
// renders silent video; its speech roulette voiced prompt descriptions). Assigned per
// character in bible order; Ana is a child voice, good for kid characters.
const CHARACTER_VOICES = (process.env.VIDS_CHARACTER_TTS_VOICES ||
  'en-US-GuyNeural,en-US-AnaNeural,en-US-AriaNeural,en-US-ChristopherNeural,en-US-MichelleNeural,en-US-BrianNeural,en-US-EmmaNeural'
).split(',').map((s) => s.trim()).filter(Boolean);

/** @description Audio duration (s) via ffmpeg -i (OSHAL_FFMPEG or PATH). @param {string} file audio file @returns {number} seconds (0 if unknown) */
function audioSeconds(file) {
  const ff = process.env.OSHAL_FFMPEG || 'ffmpeg';
  const r = cp.spawnSync(ff, ['-i', file], { encoding: 'utf8' });
  const m = ((r.stderr || '') + (r.stdout || '')).match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** @description Synthesize text with Edge neural TTS to an mp3. @param {string} text narration @param {string} outFile .mp3 path @param {string} voice Edge voice name @returns {Promise<void>} */
async function synthEdge(text, outFile, voice) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const res = tts.toStream(text);
  const stream = res && res.audioStream ? res.audioStream : res; // API differs across versions
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    stream.pipe(out);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 500) throw new Error('edge tts produced no audio');
}

/** @description Offline fallback: Windows SAPI to a wav. @param {string} text narration @param {string} outFile .wav path @returns {void} */
function synthSapi(text, outFile) {
  const psText = text.replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}')`,
    '$s.Rate = -1',
    `$s.Speak('${psText}')`,
    '$s.Dispose()',
  ].join('; ');
  const r = cp.spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(outFile) || fs.statSync(outFile).size < 500) {
    throw new Error(`SAPI narration failed: ${(r.stderr || '').slice(0, 200)}`);
  }
}

/**
 * @description Synthesize one narration line to an audio file. Edge first, SAPI fallback.
 * @param {string} text the beat's script text (the original words, quotes and all — storyteller style)
 * @param {string} outBase output path WITHOUT extension
 * @param {{voice?:string}} [opts] voice override
 * @returns {Promise<{ok:boolean, file?:string, engine?:string, error?:string}>} result
 */
async function synthNarration(text, outBase, opts = {}) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'empty narration text' };
  try {
    const mp3 = outBase + '.mp3';
    await synthEdge(clean, mp3, opts.voice || DEFAULT_VOICE);
    return { ok: true, file: mp3, engine: 'edge' };
  } catch (err) {
    try {
      const wav = outBase + '.wav';
      synthSapi(clean, wav);
      return { ok: true, file: wav, engine: 'sapi' };
    } catch (err2) {
      return { ok: false, error: `edge: ${String(err && err.message)}; sapi: ${String(err2 && err2.message)}` };
    }
  }
}

/**
 * @description Synthesize narration for every beat into the stage dir.
 * Beat narration may be a plain string OR `{text, at}` (authored shot list —
 * `at` = seconds into the scene where the line starts; drives the mix offset
 * AND the window in which the clip audio is ducked under the narrator).
 * Beats with no narration yield null (that scene keeps its own audio untouched).
 * @param {{n:number, narration:string|{text:string,at:number}|null}[]} beats built beats
 * @param {string} stageDir where the per-scene audio lands
 * @param {string} baseName filename stem (matches the scene clips)
 * @param {{voice?:string, onEvent?:function}} [opts] options
 * @returns {Promise<{entries:({file:string,atMs:number}|null)[], engine:string|null, failures:number}>} per-beat narration entries
 */
async function narrateBeats(beats, stageDir, baseName, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const entries = [];
  let engine = null;
  let failures = 0;
  for (const beat of beats) {
    const text = typeof beat.narration === 'string' ? beat.narration : (beat.narration && beat.narration.text) || '';
    if (!text.trim()) { entries.push(null); continue; }
    const atMs = typeof beat.narration === 'object' && beat.narration && Number.isFinite(Number(beat.narration.at))
      ? Math.round(Number(beat.narration.at) * 1000)
      : 400;
    const outBase = path.join(stageDir, `${baseName}_narr${String(beat.n).padStart(2, '0')}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await synthNarration(text, outBase, { voice: opts.voice });
    if (r.ok) { entries.push({ file: r.file, atMs }); engine = engine || r.engine; }
    else { entries.push(null); failures += 1; onEvent({ type: 'log', message: `narration ${beat.n} failed: ${r.error}` }); }
  }
  return { entries, engine, failures };
}

/**
 * @description v8 — build the FULL local soundtrack for every beat: character
 * dialogue lines (each character a distinct consistent voice, sequenced within the
 * scene with real measured durations) plus the narrator's [VO] line at its window.
 * Veo clips are silent; this is the only speech in the video.
 * @param {{n:number, narration:string|{text:string,at:number}|null, dialogue?:{name:string,line:string}[]}[]} beats built beats
 * @param {object[]} characters bible (order fixes each character's voice)
 * @param {string} stageDir output dir
 * @param {string} baseName filename stem
 * @param {{onEvent?:function, narratorVoice?:string}} [opts] options
 * @returns {Promise<{tracks:({file:string,atMs:number}[])[], engine:string|null, failures:number}>} per-beat event arrays
 */
async function soundtrackBeats(beats, characters, stageDir, baseName, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const voiceOf = new Map((characters || []).map((c, i) => [String(c.name).toLowerCase(), CHARACTER_VOICES[i % CHARACTER_VOICES.length]]));
  const tracks = [];
  let engine = null;
  let failures = 0;
  for (const beat of beats) {
    const events = [];
    // dialogue: sequential from +600ms, real duration + 350ms gap between lines
    let cursor = 600;
    const dial = Array.isArray(beat.dialogue) ? beat.dialogue : [];
    for (let i = 0; i < dial.length; i++) {
      const d = dial[i];
      const voice = voiceOf.get(String(d.name).toLowerCase()) || CHARACTER_VOICES[0];
      const outBase = path.join(stageDir, `${baseName}_d${String(beat.n).padStart(2, '0')}_${i}`);
      // eslint-disable-next-line no-await-in-loop
      const r = await synthNarration(d.line, outBase, { voice });
      if (r.ok) {
        events.push({ file: r.file, atMs: cursor });
        cursor += Math.round(audioSeconds(r.file) * 1000) + 350;
        engine = engine || r.engine;
      } else { failures += 1; onEvent({ type: 'log', message: `dialogue ${beat.n}.${i} (${d.name}) failed: ${r.error}` }); }
    }
    // narration [VO] at its authored window (after dialogue if they'd collide)
    const nText = typeof beat.narration === 'string' ? beat.narration : (beat.narration && beat.narration.text) || '';
    if (nText.trim()) {
      const wantMs = typeof beat.narration === 'object' && Number.isFinite(Number(beat.narration.at)) ? Math.round(Number(beat.narration.at) * 1000) : 400;
      const atMs = Math.max(wantMs, events.length ? cursor : wantMs);
      const outBase = path.join(stageDir, `${baseName}_n${String(beat.n).padStart(2, '0')}`);
      // eslint-disable-next-line no-await-in-loop
      const r = await synthNarration(nText, outBase, { voice: opts.narratorVoice || DEFAULT_VOICE });
      if (r.ok) { events.push({ file: r.file, atMs }); engine = engine || r.engine; }
      else { failures += 1; onEvent({ type: 'log', message: `narration ${beat.n} failed: ${r.error}` }); }
    }
    tracks.push(events);
  }
  return { tracks, engine, failures };
}

module.exports = { synthNarration, narrateBeats, soundtrackBeats, CHARACTER_VOICES };
