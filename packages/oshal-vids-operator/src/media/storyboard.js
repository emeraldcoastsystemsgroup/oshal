'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard stills generator (the missing step 2 of the I2V recipe): per-scene DIRECTED panels via the Gemini image API with the hero image as the character reference — each panel depicts its beat with a real composition, so the animation stage only adds small motion.
 */
/**
 * @description Per-scene storyboard stills — the step that makes it a STORY.
 *
 * One shared anchor frame kept characters consistent but produced undirected,
 * samey scenes (operator: "the scenes don't make sense… it doesn't tell a
 * story"). The full I2V recipe generates a DIRECTED still per beat: the hero
 * image rides along as the character reference, and each prompt is a storyboard
 * panel — composition + subject + action + emotion — so every scene visibly
 * depicts its moment BEFORE any motion is added.
 *
 * Engine: Gemini image model (gemini-2.5-flash-image / "nano-banana") via the
 * generativelanguage REST API with GOOGLE_API_KEY (env VIDS_IMAGE_MODEL to
 * override the model). Character reference = inline image part + text prompt.
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.VIDS_IMAGE_MODEL || 'gemini-2.5-flash-image';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** @description Simple shot grammar: pick a composition for a beat so panels vary like a real storyboard. @param {string} text beat text @param {number} i beat index @param {number} n total beats @returns {string} composition directive */
function compositionFor(text, i, n) {
  const t = String(text).toLowerCase();
  if (i === 0) return 'WIDE ESTABLISHING SHOT introducing the characters in the setting';
  if (i === n - 1) return 'WIDE CELEBRATORY FINAL SHOT, characters together, joyful ending';
  if (/said|says|"|call|shout|cried|ask/.test(t)) return 'MEDIUM TWO-SHOT, the characters facing each other, expressive faces';
  if (/sprint|ran|run|dash|race[sd]?|hurr|sped|fast/.test(t)) return 'DYNAMIC SIDE TRACKING SHOT, strong sense of speed and direction of travel';
  if (/sleep|nap|curl|doz|tired|yawn/.test(t)) return 'CLOSE-UP on the sleeping/tired character, soft quiet mood';
  if (/plod|stepp?|steady|walk|kept going|never stopped/.test(t)) return 'MEDIUM SHOT low to the ground following the slow steady movement';
  if (/finish|line|cheer|won|winner|crowd/.test(t)) return 'WIDE SHOT of the finish area with depth, outcome clearly visible';
  return i % 2 === 0 ? 'MEDIUM SHOT clearly depicting the action' : 'WIDE SHOT with the characters small in the landscape, clear action';
}

/**
 * @description Generate ONE storyboard still from the hero reference + a panel prompt.
 * @param {string} heroPath character-reference image (png/jpg)
 * @param {string} panelPrompt the directed panel description
 * @param {string} outPng destination
 * @param {{apiKey?:string}} [opts] key override (default GOOGLE_API_KEY/GEMINI_API_KEY env)
 * @returns {Promise<{ok:boolean, file?:string, error?:string}>} result
 */
async function generateStill(heroPath, panelPrompt, outPng, opts = {}) {
  // Engine order: Vertex (project billing — the AI-Studio free tier 429'd flat) when a
  // bearer token + project are provided; otherwise the plain API key path.
  const vertexToken = opts.vertexToken || process.env.VIDS_VERTEX_TOKEN;
  const vertexProject = opts.vertexProject || process.env.VERTEX_PROJECT;
  const key = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!vertexToken && !key) return { ok: false, error: 'no VIDS_VERTEX_TOKEN or GOOGLE_API_KEY for the image model' };
  if (!fs.existsSync(heroPath)) return { ok: false, error: `hero reference not found: ${heroPath}` };
  const mime = /\.png$/i.test(heroPath) ? 'image/png' : 'image/jpeg';
  const body = {
    contents: [{
      role: 'user', // Vertex requires an explicit role
      parts: [
        { inline_data: { mime_type: mime, data: fs.readFileSync(heroPath).toString('base64') } },
        { text: panelPrompt },
      ],
    }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };
  const url = vertexToken && vertexProject
    ? `https://us-central1-aiplatform.googleapis.com/v1/projects/${vertexProject}/locations/us-central1/publishers/google/models/${MODEL}:generateContent`
    : `${API}/${MODEL}:generateContent?key=${key}`;
  const headers = { 'content-type': 'application/json' };
  if (vertexToken && vertexProject) headers.authorization = `Bearer ${vertexToken}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, error: `image API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const data = img && (img.inlineData?.data || img.inline_data?.data);
  if (!data) {
    const text = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
    return { ok: false, error: `no image in response${text ? ` (model said: ${text})` : ''}` };
  }
  fs.writeFileSync(outPng, Buffer.from(data, 'base64'));
  return { ok: true, file: outPng };
}

/**
 * @description Generate the full storyboard: one directed still per beat.
 * @param {{n:number, narration:string}[]} beats built beats (narration = the beat's script text)
 * @param {string} heroPath character-reference image
 * @param {string} stageDir output dir
 * @param {string} baseName filename stem
 * @param {{style?:string, setting?:string, onEvent?:function, apiKey?:string}} [opts] style/setting reminders for the panel prompts
 * @returns {Promise<{files:(string|null)[], failures:number}>} per-beat still paths (null on failure)
 */
async function generateStoryboard(beats, heroPath, stageDir, baseName, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const files = [];
  let failures = 0;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const comp = compositionFor(beat.narration, i, beats.length);
    const prompt =
      `Look at the reference image: these EXACT characters, in this EXACT hand-drawn crayon style ` +
      `(wax crayon on white construction paper, wobbly outlines, flat colors), in this EXACT world. ` +
      `Draw a NEW storyboard panel from the same picture book: ${comp}. ` +
      `THE MOMENT TO DEPICT: ${String(beat.narration).replace(/["“”]/g, '')} ` +
      `${opts.setting ? `Setting stays: ${opts.setting} ` : ''}` +
      `The panel must clearly SHOW this moment happening — poses, expressions, and placement tell the story at a glance. ` +
      `Keep every character's colors and design identical to the reference. Landscape 16:9. ` +
      `No text, no words, no letters, no captions, no panel borders.`;
    const outPng = path.join(stageDir, `${baseName}_board${String(beat.n).padStart(2, '0')}.png`);
    // eslint-disable-next-line no-await-in-loop
    const r = await generateStill(heroPath, prompt, outPng, { apiKey: opts.apiKey });
    if (r.ok) { files.push(r.file); onEvent({ type: 'log', message: `board ${beat.n}/${beats.length} ✓ (${comp.split(' ')[0].toLowerCase()}${comp.split(' ')[1] ? ' ' + comp.split(' ')[1].toLowerCase() : ''})` }); }
    else { files.push(null); failures += 1; onEvent({ type: 'log', message: `board ${beat.n} FAILED: ${r.error}` }); }
  }
  return { files, failures };
}

module.exports = { generateStill, generateStoryboard, compositionFor };
