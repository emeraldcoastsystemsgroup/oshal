'use strict';
/**
 * @description The 5 spokes — production archetypes the planner builds to.
 *
 * A "spoke" is a video type with a fixed shape and style. A pushed story can name
 * its spoke, or we detect it from the idea. The planner injects the spoke's
 * structure + style so a sports recap looks like a sports recap and a whiteboard
 * explainer looks hand-drawn — the system isn't one-size-fits-all.
 */
const SPOKES = {
  'sports-review': {
    name: 'Sports review',
    keywords: ['sport', 'sports', 'game', 'match', 'highlight', 'recap', 'score', 'stats', 'team', 'player', 'league'],
    structure:
      'HOOK: the single best highlight moment (dynamic motion). BUILD: 1-2 more key plays. ' +
      'STATS: a scoreboard / stats card (final score + 2-3 key numbers) as a TEXT/Image layer, not baked into a clip. ' +
      'RECAP: a quick closing line / who-won. Energetic pacing.',
    style:
      'Broadcast-energetic: punchy motion, stadium/court lighting, fast slow-mo on the big play, bold sans-serif score graphics, an upbeat music bed with a hit on the key moment.',
  },
  'whiteboard-explainer': {
    name: 'Whiteboard explainer',
    keywords: ['whiteboard', 'explain', 'how it works', 'how its done', 'how to', 'educational', 'lesson', 'teach', 'tutorial', 'concept', 'diagram'],
    structure:
      'INTRO: the question / what we will explain. STEPS: 2-4 shots each drawing ONE idea building on the last (a diagram forming). ' +
      'RECAP: the whole diagram assembled. Add labels as TEXT layers at each step.',
    style:
      'Hand-drawn whiteboard look: black marker lines appearing on a clean white board, simple icons/arrows, calm steady pace, a light neutral music bed, friendly clear labels.',
  },
  'stick-figure-comedy': {
    name: 'Stick-figure joke',
    keywords: ['joke', 'funny', 'comedy', 'stick figure', 'stick-figure', 'meme', 'skit', 'gag', 'lol', 'humor', 'humour'],
    structure:
      'SETUP: establish the stick-figure character + situation (1 shot). ESCALATE: the bit builds (1 shot). ' +
      'PUNCHLINE: the comedic payoff (1 shot), held a beat. Optional kicker text card.',
    style:
      'Minimal stick-figure animation on a plain background, exaggerated timing, a beat of silence before the punchline, light comedic sting/boing audio, a punchy caption on the punchline.',
  },
  'blog-vlog': {
    name: 'Blog / vlog',
    keywords: ['blog', 'vlog', 'story time', 'storytime', 'diary', 'update', 'episode', 'part 2', 'channel', 'subscribe'],
    structure:
      'INTRO: a title/hook card + opening shot ("hey, today..."). STORY: 1-2 shots carrying the narrative. ' +
      'CLOSING: a wrap-up shot. CTA: an end card — "click here for part 2" / subscribe — as a TEXT layer.',
    style:
      'Warm, personal, casual handheld feel, soft natural light, friendly title + end-card graphics, a mellow music bed under the talking beats.',
  },
  'promo-brand': {
    name: 'Brand promo',
    keywords: ['promo', 'brand', 'commercial', 'ad', 'advert', 'launch', 'product', 'company', 'teaser'],
    structure:
      'HOOK: a striking brand image. BUILD: show the value / product in motion. ' +
      'PAYOFF: resolve to the logo moment + a tagline TEXT layer. Tight and premium.',
    style:
      'Premium and cinematic: one consistent brand palette across all shots, slow deliberate camera moves, volumetric light, a clean logo reveal, a refined music swell. No text baked into clips — layer the tagline.',
  },
};

/** Detect a spoke from an idea's words; null if none clearly matches. */
function detectSpoke(idea) {
  const t = String(idea || '').toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [key, spoke] of Object.entries(SPOKES)) {
    const hits = spoke.keywords.reduce((n, k) => (t.includes(k) ? n + 1 : n), 0);
    if (hits > bestHits) { best = key; bestHits = hits; }
  }
  return bestHits > 0 ? best : null;
}

module.exports = { SPOKES, detectSpoke };
