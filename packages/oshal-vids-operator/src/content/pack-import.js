'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Importer for operator-authored story-pack folders (frames/ + script.md + animation.md + narration.md) — parses them into the authored shot-list model so packs render via the v7 pipeline with the operator's own start-frame images.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 30-video mini-series pack support: animation.md's v2 shot table (| Time | Start Frame | Tag | Shot Direction |) is now the authoritative scene list (script.md only carries sparse dialogue rows in these packs — deriving scenes from it dropped 9 of 10 shots), Characters blocks may be a markdown table as well as bullets, and edit-speak shot directions (intro splice / transition out) are scrubbed so they never reach a Veo prompt.
 */
/**
 * @description Story-pack folder importer.
 *
 * The operator authors packs as folders (output/kids-story-packs/<story>/):
 *   frames/scene-NN-*.png  — start-frame image per scene (the panel Veo animates)
 *   script.md              — characters + scenes: timecode, frame ref, dialogue lines
 *   animation.md           — per-scene Camera / Action / Sound direction
 *   narration.md           — table of |M:SS-M:SS| "line"| narration windows
 *
 * parsePack() turns one folder into the authored shot-list story object
 * (script.js buildShotList consumes it): per shot — animation direction
 * (camera+action), dialogue [{who,line}], narration {at,text} with `at` relative
 * to the shot's own start, and `frame` (absolute path to the still).
 */
const fs = require('fs');
const path = require('path');

/** @description "M:SS" → seconds. @param {string} t timecode @returns {number} seconds */
function tSec(t) {
  const m = String(t).trim().match(/^(\d+):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** @description Stable voice per character NAME (hash-based) — the same character keeps the same voice across every episode of a series, regardless of list order. @param {string} name character name @returns {string} voice descriptor */
function voiceFor(name) {
  const palette = [
    'a bright, cheerful upbeat voice',
    'a warm, friendly medium voice',
    'a tiny, squeaky high voice',
    'a deep, slow gentle voice',
    'a crisp, chirpy quick voice',
    'a bouncy, playful voice',
    'a calm, smooth low voice',
  ];
  let h = 0;
  for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/**
 * @description Apply one v2 script/animation table row to a shot — dialogue and
 * stage rows join the shot's ORDERED event sequence (row order = time order),
 * SFX rows collect as ambience, transition/title rows are edit concerns.
 * @param {object} shot the shot being built
 * @param {string} tag row tag (DIALOGUE|STAGE|SFX|TRANSITION|TITLE)
 * @param {string} who character column (may be empty)
 * @param {string} text line/direction column
 * @param {function} canonName short-name → bible-name resolver
 * @returns {void}
 */
function applyScriptRow(shot, tag, who, text, canonName) {
  if (!shot.events) shot.events = [];
  if (!shot.sfx) shot.sfx = [];
  if (!text) return;
  const kind = String(tag).trim().toUpperCase();
  if (kind === 'DIALOGUE') {
    const d = { who: canonName(String(who).trim().replace(/-$/, '').trim() || 'Narrator'), line: text };
    shot.dialogue.push(d);
    shot.events.push({ type: 'line', ...d });
  } else if (kind === 'STAGE') {
    // Stage rows keep their PLACE in the sequence — a giggle after the punchline
    // must happen after the punchline (operator: "the group laughed before the joke").
    shot.events.push({ type: 'motion', text, who: canonName(String(who).trim().replace(/-$/, '').trim() || '') });
  } else if (kind === 'SFX') shot.sfx.push(text);
  // [TRANSITION] = stitcher concern, [TITLE] = on-screen text (conflicts with the no-text rule) — never Veo.
}

// Edit-speak in shot directions ("Reusable intro splice lands…", "transition/splice
// exits to credits") is for the stitcher — in a Veo prompt it reads as an instruction
// to draw titles/wipes. Scrubbed shots fall back to the default gentle-motion prompt.
const EDIT_SPEAK = /\b(splice|reusable (intro|transition)|credits|next episode|title card)\b/i;

/**
 * @description Parse animation.md's v2 shot table — | Time | Start Frame | Tag | Shot Direction | —
 * into the authoritative ordered shot list (one shot per unique frame ref). The 30-video
 * mini-series packs author ALL shots here; script.md only adds sparse dialogue rows.
 * @param {string} animMd animation.md content
 * @param {string} dir pack folder (frame refs resolve against it)
 * @returns {object[]} ordered shots (empty when the table format is absent)
 */
function parseAnimShots(animMd, dir) {
  const byFrame = new Map();
  for (const m of String(animMd).matchAll(/\|\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*\|\s*`([^`]+)`\s*\|\s*\[(\w+)\]\s*\|\s*([^|]+)\|/g)) {
    const [, t0, t1, frameRel, tag, direction] = m;
    const key = frameRel.trim();
    if (!byFrame.has(key)) {
      byFrame.set(key, {
        t0: tSec(t0), t1: tSec(t1), title: `Shot ${byFrame.size + 1}`,
        frame: path.resolve(dir, key), dialogue: [], animation: '', narration: null, sfx: [], events: [],
      });
    }
    const shot = byFrame.get(key);
    shot.t1 = Math.max(shot.t1, tSec(t1));
    const text = direction.trim();
    if (String(tag).trim().toUpperCase() === 'STAGE' && text && !EDIT_SPEAK.test(text)) {
      shot.animation = `${shot.animation} ${text}`.trim();
    }
  }
  const out = [...byFrame.values()];
  // Scrubbed (edit-speak) shots still need a motion direction — a bare "Animate this
  // image" prompt gives Veo nothing to do. (Not the legacy "Bring this moment…" default:
  // buildShotList strips that phrase.)
  for (const s of out) if (!s.animation) s.animation = 'Small, gentle natural motion — the characters settle into the scene, breathe, blink, and glance around.';
  return out;
}

/**
 * @description Parse the Characters block — either "- Name: description" bullets or a
 * markdown table (| Character | Description |). @param {string} scriptMd script.md content
 * @returns {{name:string,description:string,voice:string}[]} cast with stable voices
 */
function parseCharacters(scriptMd) {
  const characters = [];
  const charBlock = (scriptMd.split(/^##\s*Characters/m)[1] || '').split(/^##\s/m)[0];
  for (const m of charBlock.matchAll(/^-\s*([^:\n]+):\s*(.+)$/gm)) {
    characters.push({ name: m[1].trim(), description: m[2].trim(), voice: voiceFor(m[1].trim()) });
  }
  for (const m of charBlock.matchAll(/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*$/gm)) {
    const name = m[1].trim();
    if (/^-+$|^Character$/i.test(name.replace(/\s/g, '')) || /^:?-{2,}/.test(m[2].trim())) continue;
    characters.push({ name, description: m[2].trim(), voice: voiceFor(name) });
  }
  return characters;
}

/**
 * @description Parse one story-pack folder into an authored shot-list story.
 * @param {string} dir absolute path of the pack folder (e.g. …/03-pancake-joke)
 * @returns {{ok:boolean, story?:object, frames?:string[], error?:string}} parsed story + per-shot frame paths
 */
function parsePack(dir) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const scriptMd = read('script.md');
  const animMd = read('animation.md');
  const narrMd = read('narration.md');
  if (!scriptMd) return { ok: false, error: `no script.md in ${dir}` };

  const id = path.basename(dir).replace(/^\d+-/, '');
  const titleM = scriptMd.match(/^#\s*Script:\s*(.+)$/m);
  const title = titleM ? titleM[1].trim() : id;

  // Characters: "- Name: description" bullets OR a | Character | Description | table.
  // Series units (intro/, episodes/*) may omit the block — "character lock comes from
  // the parent series-bible.md" (pack README), so fall back to its ## Cast table.
  let characters = parseCharacters(scriptMd);
  if (!characters.length) {
    for (const up of ['..', path.join('..', '..')]) {
      const bible = read(path.join(up, 'series-bible.md'));
      if (!bible) continue;
      characters = parseCharacters(bible.replace(/^##\s*Cast\b/m, '## Characters'));
      if (characters.length) break;
    }
  }

  const canonName = (who) => {
    // Scripts abbreviate ("Pippa:") while the character list is full ("Pippa Pancake") —
    // canonicalize so the voice lookup in buildShotList matches.
    const full = characters.find((c) => c.name.toLowerCase() === who.toLowerCase()
      || c.name.toLowerCase().startsWith(who.toLowerCase() + ' ')
      || who.toLowerCase().startsWith(c.name.toLowerCase() + ' '));
    return full ? full.name : who;
  };

  const shots = [];
  // Mini-series packs: animation.md's shot table is the authoritative scene list —
  // script.md rows only ADD dialogue/stage events to those shots (matched by frame ref).
  const animShots = parseAnimShots(animMd, dir);
  // v2 FORMAT (script-format.md, 2026-07-07): Mode header + 6-column tagged table —
  // | Time | Frame | Tag | Character | Line | Generator Use |
  // Scenes = unique frame refs in first-appearance order; a scene's window spans its rows.
  const v2Rows = [...scriptMd.matchAll(/\|\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*\|\s*`([^`]+)`\s*\|\s*\[(\w+)\]\s*\|\s*([^|]*)\|\s*"?([^"|]*?)"?\s*\|/g)];
  if (v2Rows.length || animShots.length) {
    const byFrame = new Map();
    for (const s of animShots) byFrame.set(path.relative(dir, s.frame).split(path.sep).join('/'), s);
    for (const r of v2Rows) {
      const [ , t0, t1, frameRel, tag, who, line ] = r;
      const key = frameRel.trim();
      if (!byFrame.has(key)) {
        byFrame.set(key, {
          t0: tSec(t0), t1: tSec(t1),
          title: key.replace(/^frames\//, '').replace(/^scene-\d+-?/, '').replace(/\.\w+$/, '').replace(/-/g, ' ') || `Shot ${byFrame.size + 1}`,
          frame: path.resolve(dir, key),
          dialogue: [], animation: '', narration: null, sfx: [], events: [],
        });
      }
      const shot = byFrame.get(key);
      if (!animShots.length) {
        // Only script-derived shots take their window from script rows — authored
        // animation windows are authoritative and must not stretch to dialogue times.
        shot.t0 = Math.min(shot.t0, tSec(t0));
        shot.t1 = Math.max(shot.t1, tSec(t1));
      }
      applyScriptRow(shot, tag, who, line.trim(), canonName);
    }
    for (const s of byFrame.values()) {
      if (s.sfx && s.sfx.length) s.animation = `${s.animation} Ambient sound: ${s.sfx.join('; ')}`.trim();
      delete s.sfx;
      shots.push(s);
    }
    if (!animShots.length) shots.sort((a, b) => a.t0 - b.t0);
  } else {
    // LEGACY format: "### T0-T1 - Title" sections with a Frame ref + Name: "line" rows.
    const sceneRe = /^###\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*-\s*(.+)$/gm;
    const sceneMatches = [...scriptMd.matchAll(sceneRe)];
    for (let i = 0; i < sceneMatches.length; i++) {
      const m = sceneMatches[i];
      const start = m.index + m[0].length;
      const end = i + 1 < sceneMatches.length ? sceneMatches[i + 1].index : scriptMd.length;
      const body = scriptMd.slice(start, end);
      const frameM = body.match(/Frame:\s*`([^`]+)`/);
      const dialogue = [];
      for (const d of body.matchAll(/^([A-Za-z][\w' -]{0,30}):\s*"([^"]+)"\s*$/gm)) {
        dialogue.push({ who: canonName(d[1].trim()), line: d[2].trim() });
      }
      shots.push({
        t0: tSec(m[1]),
        t1: tSec(m[2]),
        title: m[3].trim(),
        frame: frameM ? path.resolve(dir, frameM[1].trim()) : null,
        dialogue,
        animation: '',
        narration: null,
      });
    }
  }
  if (!shots.length) return { ok: false, error: `no scenes parsed from script.md in ${dir}` };

  // Animation direction: "## T0-T1 - Title" blocks with Camera/Action (+Sound as ambience hint).
  const animRe = /^##\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*-\s*(.+)$/gm;
  const animMatches = [...animMd.matchAll(animRe)];
  for (let i = 0; i < animMatches.length; i++) {
    const m = animMatches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < animMatches.length ? animMatches[i + 1].index : animMd.length;
    const body = animMd.slice(start, end);
    const grab = (label) => { const g = body.match(new RegExp(`^${label}:\\s*(.+)$`, 'm')); return g ? g[1].trim() : ''; };
    const target = shots.find((s) => s.t0 === tSec(m[1])) || shots[i];
    if (target) {
      const parts = [grab('Camera') && `Camera: ${grab('Camera')}`, grab('Action'), grab('Sound') && `Ambient sound: ${grab('Sound')}`].filter(Boolean);
      target.animation = parts.join(' ');
    }
  }
  for (const s of shots) if (!s.animation) s.animation = `Bring this moment to life with small, natural motion: ${s.title}.`;

  // Narration handling is AUTHOR INTENT (narration-format.md, 2026-07-07). Modes:
  //   voiceover | spoken      (default) — untagged lines are narrator VO
  //   stage-direction | directions      — untagged lines are visual cues
  //   off                               — lines ignored
  //   mixed                             — per-line tags are mandatory
  // Row tags: [VO] spoken; [STAGE] fold into animation; [SFX]/[TRANSITION] fold as
  // sound/edit hints; [TITLE] skipped (on-screen text conflicts with the no-text rule).
  const modeM = narrMd.match(/^Mode:\s*(voiceover|spoken|stage-direction|directions|off|mixed)\s*$/mi);
  const raw = modeM ? modeM[1].toLowerCase() : 'voiceover';
  const narrMode = raw === 'voiceover' ? 'spoken' : raw === 'stage-direction' ? 'directions' : raw;
  const applyLine = (t0str, kind, text) => {
    const at = tSec(t0str);
    const shot = shots.find((s) => at >= s.t0 && at < s.t1) || shots[shots.length - 1];
    if (kind === 'stage') shot.animation = `${shot.animation} Also visible in this shot: ${text}`.trim();
    else if (kind === 'sfx') shot.animation = `${shot.animation} Ambient sound: ${text}`.trim();
    else if (kind === 'transition') shot.animation = `${shot.animation} Transition: ${text}`.trim();
    else if (kind === 'vo') {
      // Offset is relative to the shot start, clamped to leave the tail breathable.
      shot.narration = { at: Math.max(0, Math.min(6, at - shot.t0)), text };
    }
  };
  if (narrMode !== 'off') {
    // Tagged rows: | M:SS-M:SS | [VO]|[STAGE]|[SFX]|[TRANSITION]|[TITLE] | line | … |
    const tagged = [...narrMd.matchAll(/\|\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*\|\s*\[(VO|STAGE|SFX|TRANSITION|TITLE)\]\s*\|\s*"?([^"|]+?)"?\s*\|/gi)];
    if (tagged.length) {
      for (const m of tagged) {
        const kind = m[3].toLowerCase() === 'title' ? 'skip' : m[3].toLowerCase();
        if (kind !== 'skip') applyLine(m[1], kind, m[4].trim());
      }
    } else {
      // Untagged rows: | M:SS-M:SS | "line" | — kind comes from the file Mode.
      for (const m of narrMd.matchAll(/\|\s*(\d+:\d{1,2})-(\d+:\d{1,2})\s*\|\s*"([^"]+)"\s*\|/g)) {
        applyLine(m[1], narrMode === 'directions' ? 'stage' : 'vo', m[3].trim());
      }
    }
  }

  const story = {
    id,
    pack: 'kids-story-packs',
    theme: 'original',
    title,
    moral: '',
    script: shots.map((s) => (s.narration ? s.narration.text : '')).filter(Boolean).join(' ') || title,
    characters,
    orientation: 'Landscape',
    shots: shots.map((s) => ({ title: s.title, animation: s.animation, dialogue: s.dialogue, narration: s.narration, events: s.events || null })),
  };
  return { ok: true, story, frames: shots.map((s) => s.frame) };
}

/** @description List pack folders under a root (NN-name dirs with a script.md). @param {string} root packs root @returns {string[]} absolute folder paths */
function listPackDirs(root) {
  try {
    return fs.readdirSync(root)
      .filter((d) => /^\d+-/.test(d) && fs.existsSync(path.join(root, d, 'script.md')))
      .sort()
      .map((d) => path.join(root, d));
  } catch { return []; }
}

module.exports = { parsePack, listPackDirs };
