'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Creative cycler: loop the library (fables/fairytales/sayings), produce the next unproduced story via Extend, save to content folder + Drive, pace between runs. The "creative bot that just cycles".
 */
/**
 * @description `oshal-vids cycle` — the creative bot that just keeps making videos.
 *
 * Loops the rotating content library: pick the NEXT unproduced story, animate it
 * across ~10 Extend scenes in Google Vids, download + save it to the content
 * folder (+ Drive), pace, repeat. Stops when the library is exhausted (unless
 * --loop wraps around), a --limit is hit, or you Ctrl-C. Needs the debug Chrome
 * up + signed into Google Vids on :9222 (npx oshal-vids chrome).
 *
 *   oshal-vids cycle                 make every unproduced story, back to back
 *   oshal-vids cycle --every 30m     pace 30 min between stories
 *   oshal-vids cycle --limit 3       stop after 3 stories this run
 *   oshal-vids cycle --loop          keep going forever (re-runs the library)
 *   oshal-vids cycle --beats 8       ~8 scenes per story
 *
 * Honest: each story is only counted done when its file actually lands; a failed
 * render is logged and the cycler moves on (it will be retried on the next run).
 */
const { produceStory } = require('../src/stories/produce');
const store = require('../src/storage/store');
const library = require('../src/content/library');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes('--' + name); }

/** @description Parse a human duration (30s/15m/3h) into ms. @param {string} s duration @returns {number} milliseconds (0 if none) */
function parseDur(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stop = false;
process.on('SIGINT', () => { console.log('\n[cycle] stopping after the current story…'); stop = true; });
process.on('SIGTERM', () => { stop = true; });

(async () => {
  const everyMs = parseDur(arg('every'));
  const limit = Number(arg('limit', 0)) || 0;
  // no default: script.js derives patient pacing (~6 words/scene) unless --beats is given
  const beats = arg('beats') ? Number(arg('beats')) : undefined;
  const loop = flag('loop');
  const total = library.allStories().length;
  console.log(`[cycle] library: ${total} stories; already produced: ${[...store.producedIds()].length}; pacing: ${everyMs ? everyMs / 1000 + 's' : 'none'}${loop ? '; looping' : ''}`);

  let made = 0;
  let failures = 0;
  while (!stop) {
    if (limit && made >= limit) { console.log(`[cycle] reached --limit ${limit}.`); break; }
    const next = library.pickNext([...store.producedIds()]);
    if (!next) {
      if (!loop) { console.log('[cycle] library exhausted — all stories produced. Done.'); break; }
      console.log('[cycle] library exhausted; --loop set but nothing new to make. Stopping (delete manifests to re-make).');
      break;
    }
    console.log(`\n[cycle] === producing ${next.pack}/${next.id}: "${next.title}" ===`);
    let r;
    try {
      r = await produceStory({ next: true, beats, onEvent: (e) => { if (e && e.message) console.log('  ', e.message); } });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (r.ok) {
      made += 1;
      console.log(`[cycle] OK ${r.story.pack}/${r.story.id} — ${r.sceneCount} scenes (${r.mode})${r.drivePending ? ' [local; Drive pending]' : ' [Drive]'} -> ${r.localPath}`);
    } else {
      failures += 1;
      console.warn(`[cycle] FAIL ${next.id}: ${r.error}`);
      if (failures >= 3 && !made) { console.error('[cycle] 3 failures with no success — stopping (check Chrome/CDP on :9222).'); break; }
    }
    if (stop) break;
    const more = !limit || made < limit;
    if (everyMs && more) { console.log(`[cycle] pacing ${everyMs / 1000}s before the next story…`); await sleep(everyMs); }
  }
  console.log(`\n[cycle] finished: ${made} made, ${failures} failed this run. Content folder: ${store.contentDir()}`);
  process.exit(failures && !made ? 1 : 0);
})();
