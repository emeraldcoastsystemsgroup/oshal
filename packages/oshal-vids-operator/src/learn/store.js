'use strict';
/**
 * @description Learning store — the operator's memory.
 *
 * Zero-native-dep JSON store under ~/.oshal-vids/ (the package dir may be
 * read-only when run via npx). It captures every run so the bot can:
 *   - reuse winning prompts (recentWins / topRated feed optimizeJob + chat)
 *   - remember selectors the vision fallback healed (recipe self-heal memory)
 *   - learn from operator ratings
 *
 * It also holds external examples: a seed set plus, when available, a remote
 * gallery fetched from VIDS_EXAMPLES_URL — "load external examples if possible".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.VIDS_DATA_DIR || path.join(os.homedir(), '.oshal-vids');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const HEALED_FILE = path.join(DATA_DIR, 'healed-selectors.json');
const EXAMPLES_CACHE = path.join(DATA_DIR, 'examples.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** A small, always-available seed of on-brand examples. */
const SEED_EXAMPLES = [
  {
    idea: 'brand hero — dew bead',
    prompt:
      'A single dew-bead settling on a dark reflective surface, a faint ripple spreading. Macro lens, slow push-in, soft key from upper left, deep shadows. Palette: deep navy, emerald green, soft white. Subtle particle whoosh with a low synth swell. No text, no logos.',
    tags: ['premium', 'macro', 'navy', 'emerald'],
  },
  {
    idea: 'tech reveal — orb orbit',
    prompt:
      'A brushed-steel orb slowly rotating above a matte black plinth in soft volumetric haze. Locked-off wide, rim light from behind. Palette: charcoal, steel, cool cyan accents. Low ambient hum. No text, no logos.',
    tags: ['tech', 'product', 'orbit'],
  },
];

class LearningStore {
  constructor() {
    this.runs = readJson(RUNS_FILE, []);
    this.healed = readJson(HEALED_FILE, {});
  }

  /** Append a finished run. Trims long fields; keeps the last 500. */
  recordRun(job, result) {
    const entry = {
      id: job.id,
      ts: new Date().toISOString(),
      idea: job.prompt,
      finalPrompt: job.finalPrompt || job.prompt,
      orientation: job.orientation,
      insertMode: job.insertMode,
      success: Boolean(result && result.ok),
      failedAt: result && result.failedAt,
      healedSteps: (result && result.healedSteps) || [],
      rating: null,
    };
    this.runs.push(entry);
    this.runs = this.runs.slice(-500);
    writeJson(RUNS_FILE, this.runs);
    // Remember any selectors the vision fallback healed, keyed by step id.
    for (const h of entry.healedSteps) {
      if (h && h.id && h.target) this.healed[h.id] = h.target;
    }
    if (entry.healedSteps.length) writeJson(HEALED_FILE, this.healed);
    return entry;
  }

  rate(jobId, rating) {
    const r = this.runs.find((x) => x.id === jobId);
    if (!r) return false;
    r.rating = Number(rating);
    writeJson(RUNS_FILE, this.runs);
    return true;
  }

  /** Best examples for prompt-shaping context: rated wins first, then recent successes. */
  bestPrompts(n = 5) {
    const rated = this.runs.filter((r) => r.success && r.rating != null).sort((a, b) => b.rating - a.rating);
    const recent = this.runs.filter((r) => r.success && r.rating == null).reverse();
    const seen = new Set();
    const out = [];
    for (const r of [...rated, ...recent]) {
      const key = r.finalPrompt;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ idea: r.idea, prompt: r.finalPrompt, rating: r.rating });
      if (out.length >= n) break;
    }
    return out;
  }

  /** Remembered selector for a step the vision fallback healed before. */
  healedTarget(stepId) {
    return this.healed[stepId] || null;
  }

  stats() {
    const total = this.runs.length;
    const wins = this.runs.filter((r) => r.success).length;
    return { total, wins, healedSelectors: Object.keys(this.healed).length };
  }

  /**
   * Examples for grounding: seed + cached remote + a fresh remote fetch when
   * VIDS_EXAMPLES_URL is set and reachable. Best-effort; never throws.
   */
  async examples() {
    let remote = readJson(EXAMPLES_CACHE, []);
    const url = process.env.VIDS_EXAMPLES_URL;
    if (url && typeof fetch === 'function') {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const body = await res.json();
          if (Array.isArray(body) && body.length) {
            remote = body.slice(0, 50);
            writeJson(EXAMPLES_CACHE, remote);
          }
        }
      } catch {
        /* offline / bad url — fall back to cache + seed */
      }
    }
    return [...SEED_EXAMPLES, ...remote];
  }
}

let singleton = null;
function getStore() {
  if (!singleton) singleton = new LearningStore();
  return singleton;
}

module.exports = { getStore, LearningStore, DATA_DIR, SEED_EXAMPLES };
