'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | StoryScript builder: split a ~100-word narration into ~N continuous beats and compose Veo scene prompts for the Extend chain.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | v2 after the live tortoise-and-hare review: patient pacing (~6 words/scene, cap 220 ≈ 30 min), pinned SETTING + full character bible restated in EVERY beat (stops the hare-turned-white drift), subject-explicit actions, and spoken audio — a named narrator voice reads each beat and attributed quotes are spoken by each character's OWN voice (in-prompt Veo speech, the only audio that survives per-clip download).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | v3 after operator review + web-researched Veo best practices: narration is a VOICE-OVER Audio block (unseen storyteller; characters' mouths STAY CLOSED — only attributed dialogue moves that ONE character's mouth); ALL quotation marks stripped from prompts (quoted speech triggers burned-in subtitles + stray lip-sync; colon format only); explicit "(no subtitles)" negatives; ~10 words/scene (Veo speech-pacing sweet spot).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | v13 (operator direction): shot prompts use Google's SCRIPT format — one line per beat, Name (look) says: "quoted line", stage directions as plain sentences in row order, one compact rules tail. The v10-v12 instruction paragraph (ordering meta + lip-sync rules) confused reviewers and widened the content-filter surface — Vids showed a live "can't be generated" policy card mid-episode.
 */
/**
 * @description StoryScript builder — turn a story into ordered, consistent,
 * voiced scene prompts for the Extend runner.
 *
 * v2 design rules (operator feedback 2026-07-06):
 *  - PATIENT: ~6 narration words per 8s scene (default), so a 100-word tale
 *    breathes across ~16 scenes; `beats` may be requested up to 220 (~30 min).
 *  - CONSISTENT: the story's pinned `setting` and the FULL `characters` bible
 *    are restated verbatim in every scene prompt — Veo never gets the chance to
 *    change the season or recolor a character.
 *  - VOICED: each beat's narration is spoken by the named narrator voice; quoted
 *    dialogue is attributed to its character (best-effort from the surrounding
 *    words) and spoken in that character's OWN voice. Audio must live INSIDE the
 *    Veo clip (a Vids voiceover track would not survive the per-clip download).
 */

/** @description Split prose into sentences, preserving order. @param {string} text narration @returns {string[]} sentences */
function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const re = /[^.!?]+[.!?]+(?:['"”’])?/g;
  let m;
  let last = 0;
  while ((m = re.exec(t))) { out.push(m[0].trim()); last = re.lastIndex; }
  const tail = t.slice(last).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/** @description Split one long segment near its middle (prefer a comma). @param {string} s segment @returns {string[]} 1-2 parts */
function splitOne(s) {
  const words = s.split(' ');
  if (words.length < 6) return [s];
  const mid = Math.floor(words.length / 2);
  let cut = -1;
  let best = Infinity;
  for (let i = 2; i < words.length - 2; i++) {
    if (/[,;:]$/.test(words[i])) { const d = Math.abs(i - mid); if (d < best) { best = d; cut = i; } }
  }
  if (cut < 0) cut = mid - 1;
  const a = words.slice(0, cut + 1).join(' ').replace(/[,;:]+$/, '');
  const b = words.slice(cut + 1).join(' ');
  return [a, b].filter(Boolean);
}

/** @description Merge many segments into exactly n balanced contiguous buckets. @param {string[]} arr segments @param {number} n target @returns {string[]} n segments */
function groupInto(arr, n) {
  const out = [];
  const per = arr.length / n;
  for (let i = 0; i < n; i++) {
    const start = Math.round(i * per);
    const end = Math.round((i + 1) * per);
    const chunk = arr.slice(start, end).join(' ').trim();
    if (chunk) out.push(chunk);
  }
  return out.length ? out : arr.slice();
}

/** @description Rebalance sentences to ~n contiguous beats. Never splits inside a quoted span (dialogue stays whole so one character speaks it in one scene). @param {string[]} sentences source @param {number} n target beats @returns {string[]} ~n segments */
function toSegments(sentences, n) {
  let segs = sentences.slice();
  let guard = 0;
  while (segs.length < n && guard++ < 300) {
    let idx = -1;
    let len = -1;
    for (let i = 0; i < segs.length; i++) {
      const wc = segs[i].split(' ').length;
      const quoted = /["“][^"”]*["”]/.test(segs[i]);
      if (wc >= 8 && !quoted && wc > len) { len = wc; idx = i; }
    }
    if (idx < 0) break; // nothing left that can split without breaking a quote
    const parts = splitOne(segs[idx]);
    if (parts.length < 2) break;
    segs.splice(idx, 1, ...parts);
  }
  if (segs.length > n) segs = groupInto(segs, n);
  return segs;
}

/** @description Filesystem-safe slug. @param {string} s text @returns {string} slug */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'story';
}

/**
 * @description Attribute quoted spans in a beat to a character from the bible.
 * A quote is attributed when a character's name appears within ~40 chars of it
 * (…said the hare / the mouse squeaked "…"). Unattributed quotes stay with the
 * narrator. @param {string} text beat text @param {object[]} characters bible
 * @returns {{narration:string, dialogue:{name:string,voice:string,line:string}[]}} split
 */
function splitDialogue(text, characters) {
  const dialogue = [];
  let narration = text;
  if (!Array.isArray(characters) || !characters.length) return { narration, dialogue };
  const quoteRe = /["“]([^"”]{2,200})["”]/g;
  let m;
  while ((m = quoteRe.exec(text))) {
    const line = m[1].trim();
    const before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60).toLowerCase();
    const ctx = before + ' ' + after;
    const speaker = characters.find((c) => {
      const bare = String(c.name || '').toLowerCase().replace(/^the\s+/, '');
      return bare && ctx.includes(bare);
    });
    if (speaker) {
      dialogue.push({ name: speaker.name, voice: speaker.voice || '', line });
      narration = narration.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
    }
  }
  // Tidy dangling attribution stubs left after removing the quote ("said the hare." etc.)
  narration = narration.replace(/(^|\s)(said|called|cried|shouted|squeaked|asked|replied|grinned|whispered)\s+(the\s+)?[a-z' -]{2,24}[.,]?/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  return { narration, dialogue };
}

const STYLE_TAIL = '(no subtitles) No subtitles. No captions, no on-screen text, no letters, no words, no logos, no speech bubbles, no name labels, no floating text of any kind.';
// ~10 narration words per 8s scene: web-researched Veo speech pacing (2026-07-06) — much
// shorter reads as gibberish/awkward silence, much longer gets unnaturally fast.
const WORDS_PER_SCENE = Number(process.env.VIDS_WORDS_PER_SCENE || 10);
const MAX_BEATS = 220; // ~30 min of 8s scenes (Vids' own project cap is 30 minutes)

/**
 * @description Build beats from an AUTHORED SHOT LIST (operator storyboard,
 * 2026-07-07): each shot carries an animation direction, in-clip dialogue
 * (colon-format attributed speech — Veo animates the mouths and speaks the short
 * lines), and optional narration placed at a second-offset for the local
 * narrator mix. The panel image carries the look; prompts direct MOTION only.
 * @param {object} story story with shots[] + characters bible
 * @returns {object} built script (same shape as buildStoryScript)
 */
function buildShotList(story) {
  const characters = Array.isArray(story.characters) ? story.characters : [];
  const voiceOf = (who) => {
    const c = characters.find((x) => String(x.name).toLowerCase() === String(who).toLowerCase());
    return c && c.voice ? c.voice : '';
  };
  // Only DOUBLE quotes trigger burned-in subtitles — keep apostrophes (I'll, I've).
  const strip = (s) => String(s).replace(/["“”]/g, '').trim();
  const title = story.title || story.id || 'Untitled';
  const beats = story.shots.map((shot, i) => {
    const n = i + 1;
    const dialogue = (shot.dialogue || []).map((d) => ({ name: d.who, voice: voiceOf(d.who), line: d.line }));
    // v10 RULES (operator, 2026-07-07, Flip Trip lessons):
    //  - Identify every speaker BY APPEARANCE — names mean nothing to Veo, which
    //    voiced the wrong characters ("the brown toast slice with the bow tie
    //    says:", not "Toasty Toast says:").
    //  - EXPLICIT ORDER: First / Then / Finally, one line each.
    //  - Never voice or describe STATE the image already shows; stage cues pass
    //    through only as terse MOTION imperatives (giggles, slides, flips).
    //  - No narrator anywhere. Veo speaks only the quoted lines; giggles allowed.
    const appearanceOf = (who) => {
      const c = characters.find((x) => String(x.name).toLowerCase() === String(who).toLowerCase());
      if (!c || !c.description) return who;
      // Appearance ONLY — a "(Name)" parenthetical made Veo draw a floating name label,
      // and the bare species noun "toast" got rendered INSIDE a speech bubble. Strip the
      // observed trigger nouns; the remaining features still identify the character.
      // Split on comma/semicolon/em-dash only — NOT ASCII hyphen (it lives inside
      // compound looks like "sunny-side-up egg"); personality clauses after ";" are
      // not appearance and must not be spoken.
      const desc = String(c.description).split(/[,;—]/)[0].replace(/^an?\s+/i, '').replace(/\.+\s*$/, '')
        .replace(/\btoast\b\s*/gi, '').replace(/\s{2,}/g, ' ').trim();
      return `the ${desc}`;
    };
    // One ORDERED sequence mixing spoken lines and motions (a giggle written after the
    // punchline happens after the punchline). Falls back to dialogue-only ordering.
    const ordered = Array.isArray(shot.events) && shot.events.length
      ? shot.events
      : dialogue.map((d) => ({ type: 'line', who: d.name, line: d.line }));
    const hasDirectedGiggle = ordered.some((e) => e.type === 'motion' && /giggl|laugh/i.test(e.text || ''));
    // v14 (operator-proven live, 2026-07-07 21:30): POINTER GRAMMAR — he generated the
    // scene himself with "the astronaut on the right says: ..." after stripping my
    // descriptions. The image already shows who's who; the prompt only POINTS with the
    // shortest unique noun ("the astronaut", "the rocket"). Names and costume
    // descriptions are noise that fight the picture.
    const handleOf = (() => {
      const clause = (c) => String(c.description || c.name).split(/[,;—]/)[0]
        .replace(/^an?\s+|^the\s+/i, '').split(/\s+(?:with|who|that|which)\s+/i)[0].trim();
      const words = (c) => clause(c).split(/\s+/).filter(Boolean);
      const handles = new Map();
      for (const c of characters) {
        let n = 1, h = '';
        do { h = words(c).slice(-n).join(' ').toLowerCase(); n++; }
        while (n <= words(c).length && characters.some((o) => o !== c && words(o).slice(-(n - 1)).join(' ').toLowerCase() === h));
        handles.set(String(c.name).toLowerCase(), h);
      }
      return (who) => handles.get(String(who).toLowerCase()) || String(who || '').toLowerCase();
    })();
    // Character NAMES never reach Veo — swap them for pointer handles everywhere,
    // including stage directions ("Pip salutes" → "the astronaut salutes").
    const deName = (text) => {
      let out = String(text);
      for (const c of characters) {
        const short = String(c.name).split(/\s+/)[0];
        out = out.replace(new RegExp(`\\b${String(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), `the ${handleOf(c.name)}`)
          .replace(new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), `the ${handleOf(c.name)}`);
      }
      return out.replace(/\bthe the\b/gi, 'the').replace(/(^|[.!?]\s+)the\b/g, (m, p) => `${p}The`);
    };
    const scriptLines = ordered.map((e) => {
      if (e.type === 'motion') return deName(strip(e.text)).replace(/([^.!?])$/, '$1.');
      return `The ${handleOf(e.who)} says: "${strip(e.line)}"`;
    });
    const spoken = ordered.some((e) => e.type === 'line');
    // Stage cues (from [STAGE] rows folded into shot.animation) — motion imperatives only.
    // v14 verb economy (operator: "you would say jumps, not bends their knees slowly
    // and thrusts upward"): drop director-speak template phrases; keep plain actions.
    const motion = deName(String(shot.animation || '')
      .replace(/Ambient sound:[^.]*\./gi, '')
      .replace(/Transition:[^.]*\.?/gi, '') // edit instructions belong to the stitcher, not Veo
      .replace(/Also visible in this shot:/gi, '')
      .replace(/Bring this moment to life[^.]*\./gi, '')
      .replace(/\b(?:Reveal the problem|Mini-climax|Tag gag|A character notices the real need)\s*:\s*/gi, '')
      .replace(/First attempt goes comically sideways[^.]*\.\s*/gi, '')
      .replace(/The team tries the kinder approach together\.?\s*/gi, '')
      .replace(/Friends react with relief[^.]*\.\s*/gi, '')
      .replace(/Let the visual gag play[^.]*\.\s*/gi, '')
      .replace(/^Establish\s+/i, '')
      .replace(/\s+/g, ' ').trim()
      .replace(/^[a-z]/, (c) => c.toUpperCase()));
    // v15 (operator, 2026-07-08): KEEP THE PROMPT SHORT. The v14 rules paragraph
    // ("Speaking voices only — no singing, no narrator, no extra voices, no laughter.
    // Keep the image's art style. (no subtitles) No subtitles, no on-screen text, no
    // speech bubbles.") made Veo return "Well, this is unexpected. Something went
    // wrong." mid-episode — every extra negative is another way to fail. One short
    // tail line only; the storyboard frame already carries the look.
    const prompt = [
      `Animate this image. ${motion ? `${motion}${/[.!?]$/.test(motion) ? '' : '.'}` : 'Small natural motion.'}`,
      ...scriptLines,
      spoken ? 'Speaking voices only, no singing. No subtitles.' : 'Nobody talks. Quiet music only.',
    ].join('\n');
    const narration = shot.narration && shot.narration.text
      ? { text: String(shot.narration.text), at: Math.max(0, Number(shot.narration.at) || 0) }
      : null;
    return { n, title: shot.title || `Shot ${n}`, narration, dialogue, prompt };
  });
  return {
    id: story.id || slugify(title),
    title,
    moral: story.moral || '',
    style: story.style || '',
    orientation: story.orientation || 'Landscape',
    beats,
    sceneCount: beats.length,
    filename: `${slugify(story.pack || story.theme || 'story')}-${slugify(story.id || title)}.mp4`,
  };
}

/**
 * @description Compose the ordered, voiced, consistency-locked scene prompts.
 * An authored `shots` list (operator storyboard) takes precedence over all
 * derived modes — it IS the direction.
 * @param {{id?:string,pack?:string,theme?:string,title?:string,moral?:string,script:string,style?:string,setting?:string,characters?:{name:string,description:string,voice?:string}[],narratorVoice?:string,orientation?:string,scenes?:string[],shots?:object[]}} story the story (library entry or ad-hoc)
 * @param {{beats?:number}} [opts] beats = requested scene count (default derives from script length at ~6 words/scene, clamped 2..220)
 * @returns {{id:string,title:string,moral:string,style:string,orientation:string,beats:{n:number,narration:string|{text:string,at:number},dialogue:object[],prompt:string}[],sceneCount:number,filename:string}} the built script
 */
function buildStoryScript(story, opts = {}) {
  if (Array.isArray(story.shots) && story.shots.length) return buildShotList(story);
  const style = String(story.style || '').trim();
  const setting = String(story.setting || '').trim();
  const characters = Array.isArray(story.characters) ? story.characters : [];
  const narratorVoice = String(story.narratorVoice || 'a warm, clear, gentle storyteller voice, lower-middle pitch').trim();
  const orientation = story.orientation || 'Landscape';
  const title = story.title || story.id || 'Untitled';

  const words = String(story.script || '').split(/\s+/).filter(Boolean).length;
  const derived = Math.round(words / WORDS_PER_SCENE);
  const requested = Math.max(2, Math.min(MAX_BEATS, Number(opts.beats) || derived || 10));

  const rawSegments = Array.isArray(story.scenes) && story.scenes.length
    ? story.scenes.map((x) => String(x).trim()).filter(Boolean)
    : toSegments(splitSentences(story.script), requested);

  const stylePrefix = style ? (style.endsWith('.') ? style + ' ' : style + '. ') : '';
  const styleSuffix = style.includes('no logos') || style.includes('no words') ? '' : ' ' + STYLE_TAIL;
  const bible = characters.length
    ? 'CHARACTERS — keep each one EXACTLY consistent, never change their colors, clothing, or design: ' +
      characters.map((c) => `${c.name} is ${String(c.description || '').replace(/\s+/g, ' ').trim()}`).join('. ') + '. '
    : '';
  const world = setting ? `FIXED SETTING — keep this world identical in every scene: ${setting.replace(/\s+/g, ' ').trim()} ` : '';

  // storyboard (I2V) mode: scene 1 is a full establishing prompt; every later scene
  // is anchored on scene 1's HERO FRAME image, so its prompt is MOTION-ONLY —
  // re-describing characters over an image anchor reintroduces drift (operator
  // guidance via Gemini, 2026-07-06). Character NAMES still appear (they reference
  // what's in the image); their appearance descriptions do not.
  // panels mode (v6 — the FULL recipe): every beat has its own DIRECTED still, so
  // EVERY prompt is motion-only, and Veo is told to produce NO speech at all — the
  // deterministic local narrator owns the words; clip audio is just an ambience bed.
  const panels = opts.mode === 'panels';
  const storyboard = opts.mode === 'storyboard' || panels;

  const beats = rawSegments.map((seg, i) => {
    const n = i + 1;
    const N = rawSegments.length;
    const { narration, dialogue } = splitDialogue(seg, characters);
    const continuity = i === 0
      ? 'Establish the setting and characters exactly as described'
      : 'Continue seamlessly from the previous shot — same world, same light, same characters exactly as described';

    // Speech rules (web-researched Veo best practices, 2026-07-06):
    //  - NO quotation marks around any speech — quoted lines trigger burned-in
    //    subtitles and stray lip-sync. Colon format only ("X says: line").
    //  - Narration is a VOICE-OVER in an Audio block: an unseen storyteller; the
    //    on-screen characters' mouths STAY CLOSED while it plays.
    //  - Only attributed dialogue moves a mouth — and only that character's.
    const stripQuotes = (s) => String(s).replace(/["“”'’]/g, '').trim();
    const audio = [];
    audio.push('Audio: soft gentle storybook music.');
    if (narration) {
      audio.push(`Voice-over by an unseen storyteller narrator (${narratorVoice}), no visible speaker, says: ${stripQuotes(narration)}`);
    }
    for (const d of dialogue) {
      audio.push(`Then ${d.name} says: ${stripQuotes(d.line)} — spoken${d.voice ? ` in ${d.voice}` : ''}, and ONLY ${d.name}'s mouth moves while saying it`);
    }
    const mouths = dialogue.length
      ? `Every other character's mouth stays closed. `
      : 'The characters do NOT talk in this scene — all mouths stay closed; the story is carried by the voice-over. ';

    const prompt = panels
      // v6: this beat has its OWN directed panel. Animate exactly what the panel shows,
      // small purposeful motion, and NO generated speech — the local narrator owns the
      // words, so Veo's audio must stay a clean instrumental/ambience bed.
      ? `Animate this image. ` +
        `SMALL, PURPOSEFUL MOTION bringing this exact moment to life: ${stripQuotes(seg)} ` +
        `${dialogue.length ? dialogue.map((d) => `${d.name}'s mouth moves silently as if speaking; every other mouth stays closed`).join('. ') + '. ' : 'All mouths stay closed — nobody talks. '}` +
        `Audio: soft gentle instrumental storybook music and quiet nature ambience ONLY — no voices, no talking, no narration, no singing. ` +
        `One gentle slow camera move, unhurried storybook pacing. Keep the drawing style, characters, and world exactly as they appear in the image.${styleSuffix}`
      : storyboard && i > 0
      // Motion-only over the hero-frame anchor: animate what's IN the image.
      ? `Animate this image. ` +
        `MOTION, slow and patient: ${stripQuotes(seg)} ` +
        mouths +
        audio.join(' ') + '. ' +
        `One gentle slow camera move, unhurried storybook pacing. Keep the drawing style, characters, and world exactly as they appear in the image.${styleSuffix}`
      : `${stylePrefix}${world}${bible}` +
        `Scene ${n} of ${N}. ${continuity}. ` +
        // In storyboard mode scene 1 doubles as the HERO FRAME source: every
        // character must be in the shot or later scenes can't reference them.
        `${storyboard && i === 0 ? 'This is a wide establishing shot with ALL the characters described above clearly visible together. ' : ''}` +
        `ACTION in this scene, slow and patient: ${stripQuotes(seg)} ` + // quote marks anywhere in the prompt can trigger burned-in subtitles
        mouths +
        audio.join(' ') + '. ' +
        `${orientation} orientation, one gentle slow camera move, unhurried storybook pacing.${styleSuffix}`;
    return { n, narration: seg, dialogue, prompt: prompt.replace(/\s+/g, ' ').trim() };
  });

  return {
    id: story.id || slugify(title),
    title,
    moral: story.moral || '',
    style,
    orientation,
    beats,
    sceneCount: beats.length,
    filename: `${slugify(story.pack || story.theme || 'story')}-${slugify(story.id || title)}.mp4`,
  };
}

module.exports = { buildStoryScript, buildShotList, splitSentences, toSegments, splitDialogue, slugify };
