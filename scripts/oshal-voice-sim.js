#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add owner-bound scenario start/status/report and manual mock relay commands.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Change Log brought to the standard block format; no behavior change.
 */
/**
 * Jarvis's simulation-only phone tool. It talks solely to /api/voice-sim on the OSHAL controller.
 * No Twilio SDK, account token, real number, or external dial endpoint is reachable from here.
 */
'use strict';

const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const BASE = (process.env.OSHAL_VOICE_SIM_API_BASE || process.env.SWARM_CONTROLLER_URL || 'http://oshal-api:5000').replace(/\/+$/, '');
const SECRET = String(process.env.SWARM_SERVICE_SECRET || '');
const HELP = {
  synthetic: true,
  usage: [
    'node /app/scripts/oshal-voice-sim.js scenarios',
    'node /app/scripts/oshal-voice-sim.js start <scenario-id>',
    'node /app/scripts/oshal-voice-sim.js status <run-id>',
    'node /app/scripts/oshal-voice-sim.js report <run-id>',
    'node /app/scripts/oshal-voice-sim.js dial <manual-run-id>',
    'node /app/scripts/oshal-voice-sim.js feed <manual-run-id> <event-json>',
    'node /app/scripts/oshal-voice-sim.js callback <manual-run-id> <callback-json>',
  ],
  note: 'Synthetic 555 destinations only. A start returns a run ID while the service completes the scripted call.',
};

async function request(method, route, data) {
  const sub = resolveExactUserSubject();
  if (!sub || !SECRET) throw new Error('owner_bound_service_auth_required');
  const base = new URL(BASE);
  if (!['http:', 'https:'].includes(base.protocol) || base.hostname === 'api.twilio.com') throw new Error('invalid_oshal_api_base');
  const response = await fetch(`${BASE}/api/voice-sim${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-service-secret': SECRET,
      'x-oshal-user-sub-b64': Buffer.from(sub, 'utf8').toString('base64url'),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`voice_sim_${response.status}:${String(result.error || 'failed')}`);
  return result;
}

async function main() {
  const [verb = 'scenarios', one, two] = process.argv.slice(2);
  if (verb === '--help' || verb === 'help') return HELP;
  if (verb === 'scenarios') return request('GET', '/scenarios');
  if (verb === 'start' && one) return request('POST', '/runs', { scenarioId: one });
  if (verb === 'status' && one) {
    const run = await request('GET', `/runs/${encodeURIComponent(one)}`);
    return { synthetic: true, runId: run.id, scenarioId: run.scenarioId, status: run.status,
      outcome: run.outcome, reason: run.reason, assessment: run.assessment, eventCount: run.events?.length };
  }
  if (verb === 'report' && one) return request('GET', `/runs/${encodeURIComponent(one)}`);
  if (verb === 'dial' && one) return request('POST', '/mock-twilio/Accounts/ACSIMULATED/Calls.json', {
    runId: one, From: '+12025550100', To: '+12025550101',
  });
  if (verb === 'feed' && one && two) {
    const input = JSON.parse(two);
    return request('POST', `/runs/${encodeURIComponent(one)}/relay`, input);
  }
  if (verb === 'callback' && one && two) {
    const input = JSON.parse(two);
    return request('POST', `/runs/${encodeURIComponent(one)}/callback`, input);
  }
  return { error: 'invalid_command', ...HELP };
}

main().then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch((error) => { process.stdout.write(JSON.stringify({ error: String(error.message || error) }) + '\n'); process.exitCode = 1; });
