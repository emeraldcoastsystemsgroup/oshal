#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vids Studio CLI: backs the registered
 *   vids_generate tool. Calls the LOCAL /api/vids API (same container), which
 *   enqueues a generate-job to the remote Vids worker via the remote-client
 *   registry. Mirrors scripts/oshal-world.js (a cli tool returning JSON on stdout
 *   for a bot to read). Needs the vids-routes module (see DEPLOY.md) to resolve.
 *
 * Verbs (argv[2]) with a JSON input object (argv[3], the tool's {input}):
 *   generate   {prompt, orientation?, insertMode?, ingredient?} -> enqueue a clip
 *   story      {storyId?|{title,script}, beats?, orientation?}  -> enqueue a specific story (Extend)
 *   story-next {beats?}                                         -> enqueue the NEXT library story (cycler)
 *   jobs       {status?, limit?}                                -> list jobs
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Send X-Service-Secret (SWARM_SERVICE_SECRET) — /api/vids is now guarded by serviceSecretOr(requiresAuth)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add story / story-next verbs — dispatch a multi-scene Extend story (or the next library story) to the remote Vids worker via POST /api/vids/story (backs creative_produce* tools).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind service calls to the exact OSHAL_USER_SUB with the canonical base64url identity header so Vids route/RLS checks never run under fleet-wide authority.
 */
'use strict';

const BASE = `http://localhost:${process.env.PORT || '5000'}/api/vids`;
const SECRET = (process.env.SWARM_SERVICE_SECRET || '').trim();
const USER_SUB = process.env.OSHAL_USER_SUB || '';
function authHeaders(extra) {
  const h = Object.assign({}, extra);
  if (SECRET) {
    h['X-Service-Secret'] = SECRET;
    if (USER_SUB) h['X-Oshal-User-Sub-B64'] = Buffer.from(USER_SUB, 'utf8').toString('base64url');
  }
  return h;
}

function parseInput(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  return r.json();
}
async function getJson(url) {
  const r = await fetch(url, { headers: authHeaders({}) });
  return r.json();
}

async function run(verb, input) {
  switch (verb) {
    case 'generate': {
      if (!input.prompt) throw new Error('prompt required');
      return postJson(`${BASE}/jobs`, {
        prompt: input.prompt,
        orientation: input.orientation,
        insertMode: input.insertMode,
        ingredient: input.ingredient,
      });
    }
    case 'story': {
      // Specific story (by library id) or ad-hoc {title, script}.
      return postJson(`${BASE}/story`, {
        storyId: input.storyId,
        title: input.title,
        script: input.script,
        beats: input.beats,
        orientation: input.orientation,
      });
    }
    case 'story-next': {
      // Next unproduced library story (the cycler).
      return postJson(`${BASE}/story`, { next: true, beats: input.beats });
    }
    case 'jobs': {
      const q = new URLSearchParams();
      if (input.status) q.set('status', input.status);
      if (input.limit) q.set('limit', String(input.limit));
      return getJson(`${BASE}/jobs?${q.toString()}`);
    }
    default:
      throw new Error(`unknown verb: ${verb}`);
  }
}

(async () => {
  const verb = process.argv[2];
  const input = parseInput(process.argv[3]);
  try {
    const out = await run(verb, input);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String((err && err.message) || err) }));
    process.exitCode = 1;
  }
})();
