'use strict';
/**
 * @description OSHAL brand vocabulary — the validated visual identity, as data.
 *
 * Single source of truth for the prompt templates that produce the OSHAL look
 * validated in the live Vids session (see BRAND-THEME.md). graphics.js builds the
 * actual clip from these; the marketing-graphics bot bakes BRAND.systemPrompt into
 * its persona so every brief it shapes stays on-brand and filter-safe.
 *
 * Rules baked in (do NOT relax — each was learned the hard way):
 *  - On-screen wordmark is lowercase "oshal"; in voiceovers it is spelled "Oh-shal"
 *    so TTS pronounces it correctly.
 *  - Veo can spell short lowercase words IF the prompt demands "clearly legible and
 *    correctly spelled". It will NOT generate a talking on-screen anchor delivering
 *    named/scripted news (deepfake filter) — narration goes through the Voiceover
 *    tool, never Veo.
 *  - Keep the whole piece ONE theme (fully modern/dynamic OR fully retro, never mixed).
 *  - No flat typed-text overlays ("no 1980s text boxes").
 */

const BRAND = {
  name: 'OSHAL',
  wordmark: 'oshal', // lowercase on screen
  spoken: 'Oh-shal', // how it is written in a voiceover script so TTS says it right
  palette: 'deep navy background with glowing electric-blue energy and bright white light',
  voice: 'Tyra (Clear, medium pitch)', // confident, professional female news-announcer
  music: 'serious, authoritative evening network-news theme',

  /** System prompt the marketing-graphics bot runs on (kept terse + load-bearing). */
  systemPrompt: `You are the OSHAL Brand Marketing / Graphics specialist. You produce ON-BRAND
motion graphics for OSHAL by driving Google Vids (Veo + Voiceover + Music), reusing
the validated brand templates — you never freestyle the look.

THE OSHAL LOOK (keep it consistent across the whole piece — fully modern/dynamic,
never mixed with retro):
- Deep navy background; glowing electric-blue energy; bright white light.
- A streak / zip of electric light races across the screen and traces out the
  LOWERCASE wordmark "oshal" in clean bright glowing letters; the first letter "o"
  ignites as a spinning sphere/orb of light; sparks + particle motion; sleek,
  modern, cinematic.
- NO flat typed-text overlays ("no 1980s text boxes"). Layer real text only when
  explicitly asked, with the Text tool — never bake words into a Veo clip except
  the brand word "oshal", which MUST be demanded "clearly legible and correctly
  spelled".

HARD LIMITS (Veo content filter — work WITHIN them):
- Veo REFUSES an on-screen AI person delivering scripted/named "news" and often
  refuses animating a real person's photo. NEVER use Veo for a talking anchor.
  For spoken narration use the dedicated VOICEOVER tool (voice: Tyra, clear,
  medium pitch — a confident professional female news announcer).
- Veo also blocks the spoken words "dollars" and "trades" and company names. For
  any spoken finance content use percentages + industry names only.
- Music (Lyria) min clip length is 30s; for news pieces use a serious, authoritative
  evening-network-news theme (dramatic strings + driving percussion), NOT a
  celebratory fanfare.

NAMING: the wordmark on screen is lowercase "oshal"; in any voiceover script write
it "Oh-shal" so the TTS pronounces it correctly.

You drive the operator's signed-in Chrome over CDP and click real pixels; you NEVER
claim a clip exists until the editor confirms the render, and you surface real
errors (including a Veo refusal) instead of inventing a result.`,
};

const BRAND_VOICE = BRAND.voice;

/**
 * The canonical electric-"oshal" Veo graphic prompt. An optional short subject
 * (e.g. "daily trade recap") only flavors the mood line — the brand motion and
 * the legibility demand are fixed.
 */
function brandGraphicPrompt(subject) {
  const flavor = subject ? ` The mood evokes "${String(subject).trim()}" without any added words.` : '';
  return (
    `A cinematic tech-brand logo animation on a deep navy background: a streak of ` +
    `glowing electric-blue energy races across the screen and traces out the ` +
    `lowercase word 'oshal' in clean bright glowing letters, the first letter o ` +
    `igniting as a spinning sphere of light, sparks and particle motion, sleek and ` +
    `modern. The word o s h a l must be clearly legible and correctly spelled. ` +
    `No other text.${flavor}`
  );
}

/**
 * Normalize a spoken line for TTS: any standalone "OSHAL"/"oshal" becomes "Oh-shal".
 * Pass a line already containing "Oh-shal" and it is left as-is.
 */
function brandVoiceover(line) {
  return String(line || '').replace(/\boshal\b/gi, BRAND.spoken);
}

/** The serious evening-news music bed prompt (Lyria). `mood` overrides the default. */
function brandMusicPrompt(mood) {
  if (mood) return String(mood).trim();
  return (
    `A serious, authoritative evening network-news signature theme: dramatic ` +
    `orchestral strings with driving steady percussion, urgent and important, a ` +
    `distinctive commanding broadcast melody, tense and professional, not ` +
    `celebratory, no fanfare.`
  );
}

module.exports = { BRAND, BRAND_VOICE, brandGraphicPrompt, brandVoiceover, brandMusicPrompt };
