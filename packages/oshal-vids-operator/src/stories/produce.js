'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Story production orchestrator: resolve a story (library id / next-unproduced / ad-hoc), build the beat script, drive the Extend runner, and save to configured storage.
 */
/**
 * @description produceStory — the one call that makes a story video end to end.
 *
 * Resolves WHAT to make (an explicit library id, the next-unproduced story for
 * the cycler, or an ad-hoc idea), builds the ~10-beat script, drives the Extend
 * runner in the signed-in Chrome, and saves the finished MP4 to the local content
 * folder + Google Drive. Used by the swarm worker tools and the standalone CLI so
 * every path produces content the same accountable way.
 */
const path = require('path');
const library = require('../content/library');
const store = require('../storage/store');
const { buildStoryScript, slugify } = require('./script');
const { StoryExtendRunner } = require('../agent/story-extend');

/**
 * @description Resolve the story object to produce from the spec.
 * @param {object} spec production spec (see produceStory)
 * @returns {object|null} a story ({id,title,script,style,pack,theme,orientation,scenes?}) or null
 */
function resolveStory(spec) {
  if (spec.story && spec.story.script) return spec.story;
  if (spec.storyId) return library.getStory(spec.storyId);
  if (spec.next) return library.pickNext([...store.producedIds()], { packOrder: spec.packOrder });
  if (spec.script || spec.idea) {
    const title = spec.title || 'Story';
    return {
      id: spec.id || slugify(title),
      title,
      script: String(spec.script || spec.idea),
      style: spec.style || '',
      pack: spec.pack || 'custom',
      theme: spec.theme || 'story',
      orientation: spec.orientation || 'Landscape',
    };
  }
  return null;
}

/**
 * @description Make a story video: resolve → build script → drive Extend → store.
 * @param {{storyId?:string, next?:boolean, story?:object, idea?:string, script?:string, title?:string, style?:string, pack?:string, theme?:string, orientation?:string, beats?:number, characterImage?:string, useExtend?:boolean, driveFolderId?:string, packOrder?:string[], onEvent?:function, isAborted?:function, waitWhilePaused?:function}} spec production spec
 * @returns {Promise<{ok:boolean, story?:object, sceneCount?:number, mode?:string, localPath?:string, drive?:object, drivePending?:boolean, notes?:string[], run?:object, error?:string}>} result
 */
async function produceStory(spec = {}) {
  const onEvent = spec.onEvent || (() => {});
  const story = resolveStory(spec);
  if (!story) return { ok: false, error: 'no story to produce (library exhausted or nothing specified)' };
  if (!story.script) return { ok: false, error: `story "${story.id || '?'}" has no script` };

  // beats: explicit override wins; otherwise script.js derives patient pacing
  // (~10 narration words per scene, up to 220 scenes ≈ 30 min).
  // mode DEFAULTS to 'storyboard' (I2V hero-frame anchoring) — the 2026-07-06 A/B
  // against the Extend chain showed identical characters/world across all scenes
  // vs cumulative drift. Pass mode:'extend' explicitly for the continuity chain.
  const mode = spec.mode || 'storyboard';
  const built = buildStoryScript(story, { beats: spec.beats, mode });
  const pack = story.pack || story.theme || 'stories';
  onEvent({ type: 'log', message: `Producing "${built.title}" — ${built.sceneCount} scenes (${pack}).` });

  const runner = new StoryExtendRunner({
    onEvent,
    cdp: spec.cdp,
    isAborted: spec.isAborted,
    waitWhilePaused: spec.waitWhilePaused,
  });
  const outFile = path.join(runner.stageDir, built.filename);
  const run = await runner.run({
    beats: built.beats,
    filename: built.filename,
    orientation: built.orientation,
    characterImage: spec.characterImage,
    useExtend: spec.useExtend,
    mode,
    outFile,
  });
  if (!run.ok) {
    return { ok: false, story: { id: story.id, title: built.title, pack }, sceneCount: run.sceneCount, mode: run.mode, notes: run.notes, run, error: run.error };
  }

  const saved = await store.saveStory(run.file, {
    pack,
    id: story.id,
    title: built.title,
    moral: built.moral,
    filename: built.filename,
    sceneCount: run.sceneCount,
    mode: run.mode,
    driveFolderId: spec.driveFolderId,
  });
  onEvent({ type: 'log', message: `Saved → ${saved.localPath}${saved.drivePending ? ' (Drive pending)' : ' + Drive'}.` });

  return {
    ok: saved.ok,
    story: { id: story.id, title: built.title, pack },
    sceneCount: run.sceneCount,
    mode: run.mode,
    localPath: saved.localPath,
    drive: saved.drive,
    drivePending: saved.drivePending,
    notes: run.notes,
    error: saved.ok ? undefined : saved.error,
  };
}

module.exports = { produceStory, resolveStory };
