'use strict';
/**
 * @description Story store — the push/pull spine.
 *
 * A "story" is a video production request and everything that comes back from
 * building it. You PUSH a story (an idea or a full storyboard plan) and later
 * PULL it back by id to get its status, plan, progress, and result (the run
 * folder of screenshots + transcript, the placed shots, the final frame).
 *
 * Persistent JSON under ~/.oshal-vids/stories/ so a pushed story survives a
 * restart and can be pulled back any time — locally or from the swarm.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../learn/store');

const STORY_DIR = path.join(DATA_DIR, 'stories');

function ensureDir() { fs.mkdirSync(STORY_DIR, { recursive: true }); }
function fileFor(id) { return path.join(STORY_DIR, `${id}.json`); }
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }

class StoryStore {
  constructor() {
    this.cache = new Map();
    try {
      for (const f of fs.existsSync(STORY_DIR) ? fs.readdirSync(STORY_DIR) : []) {
        if (f.endsWith('.json')) { const s = readJson(path.join(STORY_DIR, f), null); if (s && s.id) this.cache.set(s.id, s); }
      }
    } catch { /* fresh */ }
  }

  _persist(story) {
    ensureDir();
    fs.writeFileSync(fileFor(story.id), JSON.stringify(story, null, 2));
    this.cache.set(story.id, story);
    return story;
  }

  /** PUSH: create a new story. id is caller-supplied or derived. */
  create({ id, idea = '', plan = null, source = 'api', siteUrl = null }) {
    const storyId = id || `story_${Date.now().toString(36)}_${Math.floor(this.cache.size + 1)}`;
    const now = new Date().toISOString();
    return this._persist({
      id: storyId,
      status: plan ? 'planned' : 'queued', // queued -> planning -> building -> done/failed
      source,
      idea,
      siteUrl,
      plan,
      jobId: null,
      progress: { steps: 0, lastAction: null },
      result: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id, patch) {
    const cur = this.cache.get(id) || readJson(fileFor(id), null);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    if (patch.progress) next.progress = { ...cur.progress, ...patch.progress };
    return this._persist(next);
  }

  /** PULL: get one story back. */
  get(id) {
    return this.cache.get(id) || readJson(fileFor(id), null);
  }

  list(limit = 50) {
    return [...this.cache.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }
}

let singleton = null;
function getStoryStore() { if (!singleton) singleton = new StoryStore(); return singleton; }

module.exports = { getStoryStore, StoryStore, STORY_DIR };
