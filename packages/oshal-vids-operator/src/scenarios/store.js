'use strict';
/**
 * @description Scenario library — canned option-presets + fill-in-the-blank
 * scripts that let the operator skip re-deriving the Google Vids click-path.
 *
 * A scenario pins WHICH Vids surface to drive (animate-image / veo-scratch /
 * avatar), the orientation, where the clip lands, and whether to add captions —
 * plus a script template whose {{blanks}} are filled from the caller's args.
 * The deterministic goal is built in server.js (buildScenarioGoal); this module
 * just loads the library, fills templates, and parses the chat invocation.
 *
 * All Vids knowledge stays in recipes/*.yaml + knowledge/*.md; this is data.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

const SCENARIOS_FILE = path.resolve(__dirname, '..', '..', 'recipes', 'scenarios.yaml');

let _cache = null;

/** Load (and cache) the scenario library. Returns { defaults, scenarios }. */
function load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(SCENARIOS_FILE, 'utf8');
    const doc = YAML.load(raw) || {};
    _cache = { defaults: doc.defaults || {}, scenarios: doc.scenarios || {} };
  } catch {
    _cache = { defaults: {}, scenarios: {} };
  }
  return _cache;
}

/** Hot-reload (used by tests / after editing the yaml). */
function reload() { _cache = null; return load(); }

/** A scenario merged with library defaults, or null if unknown. */
function get(id) {
  const { defaults, scenarios } = load();
  const s = scenarios[id];
  if (!s) return null;
  return { id, ...defaults, ...s };
}

/** Lightweight catalog for the panel/API (no internals). */
function list() {
  const { scenarios } = load();
  return Object.entries(scenarios).map(([id, s]) => ({
    id,
    label: s.label || id,
    surface: s.surface || 'animate-image',
    needsImage: Boolean(s.needsImage),
    vars: Object.keys(s.vars || {}),
  }));
}

/** Fill {{blanks}} in a string from `vars`; missing keys become ''. */
function interpolate(text, vars) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

/**
 * Resolve a scenario into a ready job spec: filled script, merged options, and
 * the list of any still-missing required blanks.
 * @returns {{ok:boolean, missing?:string[], spec?:object}}
 */
function resolve(id, args = {}) {
  const s = get(id);
  if (!s) return { ok: false, error: `Unknown scenario "${id}". Known: ${list().map((x) => x.id).join(', ')}` };

  // Merge declared defaults under caller args; a var whose default is undefined
  // (YAML `name:` with no value) is REQUIRED and must be supplied.
  const declared = s.vars || {};
  const vars = {};
  const missing = [];
  for (const [k, def] of Object.entries(declared)) {
    if (args[k] != null && String(args[k]).trim() !== '') vars[k] = args[k];
    else if (def != null) vars[k] = def;             // has a default (incl. "")
    else missing.push(k);                             // required, not supplied
  }
  if (s.needsImage && !args.image) missing.push('image');
  if (missing.length) return { ok: false, missing, scenario: s };

  const script = interpolate(s.script, vars).replace(/\s+/g, ' ').trim();
  return {
    ok: true,
    spec: {
      kind: 'vids',
      scenario: id,
      surface: s.surface || 'animate-image',
      orientation: s.orientation,
      insertMode: s.placement,
      captions: s.captions !== false,
      motion: s.motion ? interpolate(s.motion, vars) : undefined,
      script,
      ingredientPath: args.image || undefined,
      // `prompt` is what the queue/history shows + what veo-scratch types.
      prompt: script,
    },
  };
}

/**
 * Parse a chat invocation into { id, args }, or null if it isn't one.
 * Accepts:  scenario:stock-picks date="June 26" picks="A; B" image=C:\a\b.png
 * Bare-word values run to the next ` key=`; quoted values may contain spaces.
 */
function parseInvocation(message) {
  const text = String(message || '').trim();
  const m = text.match(/^scenario:([\w-]+)\s*(.*)$/is);
  if (!m) return null;
  const id = m[1];
  const rest = m[2] || '';
  const args = {};
  // key="quoted value"  |  key='quoted'  |  key=bareword-up-to-next-key
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s][^=]*?))(?=\s+\w+\s*=|\s*$)/g;
  let mm;
  while ((mm = re.exec(rest)) !== null) {
    const key = mm[1];
    const val = (mm[2] ?? mm[3] ?? mm[4] ?? '').trim();
    args[key] = val;
  }
  return { id, args };
}

module.exports = { load, reload, get, list, resolve, parseInvocation, interpolate, SCENARIOS_FILE };
