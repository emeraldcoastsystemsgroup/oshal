'use strict';
/**
 * @description Vids tool registry (ADR-073, Phase 2).
 *
 * Loads `recipes/vids-tools.yaml` — the catalog of named Google Vids operations
 * the director LLM can call (`generate_clip`, `add_caption`, `add_text`, …).
 * Each tool carries a `description` (so the director knows when to call it),
 * `params`, and deterministic `steps` (the click-path). This module is data
 * access + param interpolation only; execution lives in `executor.js`.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

const TOOLS_FILE = path.resolve(__dirname, '..', '..', 'recipes', 'vids-tools.yaml');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    const doc = YAML.load(fs.readFileSync(TOOLS_FILE, 'utf8')) || {};
    const tools = Array.isArray(doc.tools) ? doc.tools : [];
    _cache = new Map(tools.map((t) => [t.name, t]));
  } catch {
    _cache = new Map();
  }
  return _cache;
}

function reload() { _cache = null; return load(); }

/** A tool definition by name, or null. */
function get(name) {
  return load().get(name) || null;
}

/** Catalog for the director prompt: [{name, description, params}]. */
function catalog() {
  return [...load().values()].map((t) => ({
    name: t.name,
    description: String(t.description || '').replace(/\s+/g, ' ').trim(),
    params: t.params || [],
  }));
}

/** Render the catalog as a compact, LLM-readable tool list. */
function catalogText() {
  return catalog()
    .map((t) => `- ${t.name}(${(t.params || []).join(', ')}) — ${t.description}`)
    .join('\n');
}

/** Deep-interpolate {{param}} tokens in a step using `params`. */
function fillStep(step, params) {
  const sub = (s) => String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params[k] != null ? String(params[k]) : ''));
  const out = {};
  for (const [k, v] of Object.entries(step)) out[k] = typeof v === 'string' ? sub(v) : v;
  return out;
}

/** A tool's steps with params filled in. Throws if the tool is unknown. */
function resolveSteps(name, params = {}) {
  const tool = get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return (tool.steps || []).map((s) => fillStep(s, params));
}

module.exports = { load, reload, get, catalog, catalogText, resolveSteps, TOOLS_FILE };
