#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-06-20 ... | maintainer@emeraldcoastsystemsgroup.com | World Intelligence CLI:
 *   backs the registered world_* tools (Layer B). Calls the LOCAL World-Intelligence API
 *   (same container) so all the wired ArangoDB graph + TimescaleDB series + Claude-via-host-
 *   OAuth classification logic is reused — the cli does not re-implement any of it. Reads
 *   (sentiment/metric/neighbors/pulls/entities) are open; ingest is token-guarded, and since
 *   this runs server-side in the container it injects WORLD_INGEST_TOKEN from the env. Mirrors
 *   scripts/oshal-feeds.js (a registered cli tool returning JSON on stdout for a bot to read).
 *
 * Verbs (argv[2]) with a JSON input object (argv[3], the tool's {input}):
 *   sentiment  {entity, days?}                  -> bias-aware sentiment (political+econ+kind)
 *   metric     {entity, metric?, days?}         -> historical metric average
 *   neighbors  {id|entity, depth?}              -> entity graph neighbourhood
 *   pulls      {entity, days?}                  -> pull-rate accounting
 *   entities   {limit?}                         -> known world subjects (what's been ingested)
 *   ingest     {q, entity, label?, sources?, limit?} -> fetch+classify+ingest news (token-guarded)
 * 2026-08-05 ... | maintainer@emeraldcoastsystemsgroup.com | Retired query-string credentials: write verbs now send WORLD_INGEST_TOKEN only in Authorization, so URLs, referrers, and access logs cannot retain it
 */
'use strict';

const BASE = `http://localhost:${process.env.PORT || '5000'}/api/world`;
const TOKEN = (process.env.WORLD_INGEST_TOKEN || '').trim();
const enc = encodeURIComponent;

/** Parse the tool {input} JSON (argv[3]); tolerate empty/garbage. */
function parseInput(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}

/** Build write-only authentication headers without ever placing the token in a URL. */
function buildWorldWriteHeaders(token = TOKEN) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function postJson(url, authenticated = false) {
  const headers = authenticated ? buildWorldWriteHeaders() : {};
  const r = await fetch(url, { method: 'POST', headers });
  return r.json();
}
async function postJsonBody(url, body, authenticated = false) {
  const headers = {
    'Content-Type': 'application/json',
    ...(authenticated ? buildWorldWriteHeaders() : {}),
  };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
}

async function run(verb, input) {
  switch (verb) {
    case 'sentiment': {
      if (!input.entity) throw new Error('entity required (world:<type>:<key>)');
      return getJson(`${BASE}/sentiment?entity=${enc(input.entity)}&days=${input.days || 90}`);
    }
    case 'metric': {
      if (!input.entity) throw new Error('entity required');
      return getJson(`${BASE}/metric?entity=${enc(input.entity)}&metric=${enc(input.metric || 'sentiment')}&days=${input.days || 90}`);
    }
    case 'neighbors': {
      const id = input.id || input.entity;
      if (!id) throw new Error('id required');
      return getJson(`${BASE}/neighbors?id=${enc(id)}&depth=${input.depth || 1}`);
    }
    case 'pulls': {
      if (!input.entity) throw new Error('entity required');
      return getJson(`${BASE}/pulls?entity=${enc(input.entity)}&days=${input.days || 30}`);
    }
    case 'entities': {
      return getJson(`${BASE}/entities?limit=${input.limit || 50}`);
    }
    case 'ingest': {
      if (!input.q || !input.entity) throw new Error('q and entity required');
      const label = input.label || input.q;
      const sources = Array.isArray(input.sources) ? input.sources.join(',') : (input.sources || '');
      let url = `${BASE}/ingest-news?q=${enc(input.q)}&entity=${enc(input.entity)}&label=${enc(label)}&limit=${input.limit || 10}`;
      if (sources) url += `&sources=${enc(sources)}`;
      return postJson(url, true);
    }
    case 'contribute': {
      // WORLD KNOWLEDGE inbound — push structured knowledge into the shared world graph. The universal
      // "everyone sends their data here" entry. input = WorldContribution {source, entities[], edges?, facts?}.
      if (!input.source || !Array.isArray(input.entities)) throw new Error('contribute needs {source, entities[]}');
      const body = { ingestedAt: new Date().toISOString(), edges: [], facts: [], ...input };
      return postJsonBody(`${BASE}/contribute`, body, true);
    }
    default:
      return { error: `unknown verb "${verb}"`, verbs: ['sentiment', 'metric', 'neighbors', 'pulls', 'entities', 'ingest', 'contribute'] };
  }
}

async function main() {
  const verb = process.argv[2] || 'entities';
  const input = parseInput(process.argv[3]);
  const out = await run(verb, input);
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}

module.exports = { buildWorldWriteHeaders, run };
