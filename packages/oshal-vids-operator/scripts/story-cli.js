'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CLI: produce a story video (library id / --next / ad-hoc script) via the Extend runner, save to content folder + Drive, print a STORY_OK/STORY_ERR sentinel.
 */
/**
 * @description `oshal-vids story` — make one story video from the command line.
 *
 *   oshal-vids story --id tortoise-and-hare [--beats 10]
 *   oshal-vids story --next                       (next unproduced from the library)
 *   oshal-vids story --script story.txt --title "My Story" [--pack custom]
 *   oshal-vids story --list                       (what's already produced)
 *
 * Needs the debug Chrome up + signed into Google Vids on :9222 (npx oshal-vids
 * chrome). Prints STORY_OK <file> on success or STORY_ERR <reason> on failure —
 * never a fabricated result.
 */
const fs = require('fs');
const { produceStory } = require('../src/stories/produce');
const store = require('../src/storage/store');
const library = require('../src/content/library');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes('--' + name); }

(async () => {
  if (flag('list')) {
    const produced = store.listProduced(100);
    console.log(`produced: ${produced.length}`);
    produced.forEach((m) => console.log(`  ${m.pack}/${m.id}  ${m.drivePending ? '(local)' : '(drive)'}  ${m.file}`));
    console.log(`library: ${library.allStories().length} stories across ${library.listPacks().length} packs`);
    return;
  }

  const spec = {
    // no default: script.js derives patient pacing (~10 words/scene) unless --beats is given
    beats: arg('beats') ? Number(arg('beats')) : undefined,
    orientation: arg('orientation'),
    characterImage: arg('image'),
    // --mode storyboard = I2V hero-frame anchoring (max consistency); default = extend chain
    mode: arg('mode'),
    onEvent: (e) => { if (e && e.message) console.log('[story]', e.message); },
  };
  if (flag('next')) spec.next = true;
  else if (arg('id')) spec.storyId = arg('id');
  else if (arg('script')) {
    const p = arg('script');
    if (!fs.existsSync(p)) { console.error('STORY_ERR script file not found:', p); process.exit(2); }
    spec.script = fs.readFileSync(p, 'utf8').replace(/\r/g, '').trim();
    spec.title = arg('title', 'Story');
    spec.pack = arg('pack', 'custom');
  } else {
    console.error('STORY_ERR need one of: --id <libraryId> | --next | --script <file> [--title] | --list');
    process.exit(2);
  }

  const r = await produceStory(spec);
  console.log(JSON.stringify({ ok: r.ok, story: r.story, sceneCount: r.sceneCount, mode: r.mode, localPath: r.localPath, drivePending: r.drivePending, notes: r.notes, error: r.error }, null, 2));
  if (r.ok) console.log('STORY_OK', r.localPath, `${r.sceneCount} scenes`, r.drivePending ? '(local; Drive pending)' : '(saved to Drive)');
  else { console.error('STORY_ERR', r.error || 'production failed'); process.exit(1); }
})().catch((e) => { console.error('STORY_ERR', e.message || e); process.exit(1); });
