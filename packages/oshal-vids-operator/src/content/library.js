'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Content library: load kid-safe public-domain packs (fables/sayings/fairytales), rotate-pick next unused story for the creative bot.
 */
/**
 * @description Content library — the corpus the creative bot cycles through.
 *
 * Loads every data-only pack under `recipes/content/*.yaml` (fables, sayings,
 * fairytales, …), each a list of short public-domain, kid-safe stories with a
 * ~100-word narration `script`. The library is pure data + selection logic: it
 * knows what stories exist and can pick the NEXT one to produce (rotating across
 * packs so the feed stays varied), given the set already produced. The bot owns
 * WHAT it makes; how it's rendered lives in the runner + storage layers.
 *
 * Adding content = dropping another `recipes/content/<pack>.yaml` file. No code.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

const CONTENT_DIR = path.resolve(__dirname, '..', '..', 'recipes', 'content');

let _cache = null;

/**
 * @description Read + parse every pack file, merging pack-level defaults
 * (style/orientation/theme) down onto each story so a story is self-contained.
 * @returns {{packs: object[], stories: object[], byId: Map<string,object>}} loaded library
 */
function load() {
  if (_cache) return _cache;
  const packs = [];
  const stories = [];
  const byId = new Map();
  let files = [];
  try {
    files = fs.readdirSync(CONTENT_DIR).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    let doc;
    try {
      doc = YAML.load(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8')) || {};
    } catch {
      continue; // a malformed pack is skipped, never crashes the loader
    }
    const packId = doc.pack || path.basename(file).replace(/\.ya?ml$/i, '');
    const pack = {
      pack: packId,
      displayName: doc.displayName || packId,
      license: doc.license || '',
      audience: doc.audience || 'general',
      theme: doc.theme || packId,
      defaultStyle: doc.defaultStyle || '',
      defaultOrientation: doc.defaultOrientation || 'Landscape',
      narratorVoice: doc.narratorVoice || '',
      count: Array.isArray(doc.stories) ? doc.stories.length : 0,
    };
    packs.push(pack);
    for (const raw of Array.isArray(doc.stories) ? doc.stories : []) {
      if (!raw || !raw.id || !raw.script) continue; // a story needs at least an id + narration
      const story = {
        id: raw.id,
        pack: packId,
        theme: raw.theme || pack.theme,
        title: raw.title || raw.id,
        moral: raw.moral || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        script: String(raw.script).trim(),
        style: raw.style || pack.defaultStyle,
        setting: raw.setting || '',                                       // pinned world (v2 — anti-drift)
        characters: Array.isArray(raw.characters) ? raw.characters : [],  // character bible (v2)
        narratorVoice: raw.narratorVoice || pack.narratorVoice || '',     // spoken narration voice (v2)
        orientation: raw.orientation || pack.defaultOrientation,
        scenes: Array.isArray(raw.scenes) && raw.scenes.length ? raw.scenes.slice() : null,
        shots: Array.isArray(raw.shots) && raw.shots.length ? raw.shots.slice() : null, // authored shot list (operator storyboard) — takes precedence in the builder
        audience: pack.audience,
        license: pack.license,
      };
      if (byId.has(story.id)) continue; // first pack wins on an id clash; ids should be unique
      byId.set(story.id, story);
      stories.push(story);
    }
  }
  _cache = { packs, stories, byId };
  return _cache;
}

/** @description Drop the cache so a freshly edited pack is picked up. @returns {object} reloaded library */
function reload() { _cache = null; return load(); }

/** @description All packs with their metadata + story counts. @returns {object[]} pack summaries */
function listPacks() { return load().packs.slice(); }

/** @description Every merged story across all packs. @returns {object[]} stories */
function allStories() { return load().stories.slice(); }

/**
 * @description Fetch one merged story by id.
 * @param {string} id story id (kebab-case slug)
 * @returns {object|null} the story, or null if unknown
 */
function getStory(id) { return load().byId.get(id) || null; }

/**
 * @description Pick the next story to produce, rotating across packs so the feed
 * stays varied. Skips ids already produced; within the least-recently-used pack
 * it returns the first not-yet-produced story. Returns null when everything is done.
 * @param {Iterable<string>} producedIds ids already produced (from the story store)
 * @param {{packOrder?: string[]}} [opts] optional explicit pack rotation order
 * @returns {object|null} the next story, or null if the whole library is exhausted
 */
function pickNext(producedIds = [], opts = {}) {
  const done = new Set(producedIds);
  const { packs, stories } = load();
  const remaining = stories.filter((s) => !done.has(s.id));
  if (!remaining.length) return null;

  // Rotate by pack: choose the pack with the FEWEST already-produced stories, so
  // fables/sayings/fairytales interleave instead of draining one pack first.
  const order = Array.isArray(opts.packOrder) && opts.packOrder.length
    ? opts.packOrder
    : packs.map((p) => p.pack);
  const producedPerPack = new Map(order.map((p) => [p, 0]));
  for (const s of stories) if (done.has(s.id) && producedPerPack.has(s.pack)) producedPerPack.set(s.pack, producedPerPack.get(s.pack) + 1);

  let bestPack = null;
  let bestCount = Infinity;
  for (const p of order) {
    if (!remaining.some((s) => s.pack === p)) continue;
    const c = producedPerPack.get(p) || 0;
    if (c < bestCount) { bestCount = c; bestPack = p; }
  }
  const pool = remaining.filter((s) => s.pack === bestPack);
  return pool[0] || remaining[0];
}

module.exports = { load, reload, listPacks, allStories, getStory, pickNext, CONTENT_DIR };
