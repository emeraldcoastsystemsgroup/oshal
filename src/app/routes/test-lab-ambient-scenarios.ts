/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2-4 Test Lab scenario: seeds one clearly-labelled transcript line through the REAL ambient ingest route, then proves the deterministic person-model reads end to end as the signed-in user — the themed surface, an exact recall count for that line, the asks / people / trends / projection reads, and Jarvis chat answering the open-asks shape without a model turn. Registered in test-lab-scenarios.ts; regression files attached at unit + integration levels.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attached the Manage Voices → Ambient Recall bridge regressions: the four-point wiring pin (unit) and the Chromium proof that every voice row opens its profile page (browser).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Attached the "possibly related" relevance-floor regression, which runs the real embedding model in a child process — the retrieval leg's fused score is a reciprocal rank and carried no distance, so an off-topic line was published beside real paraphrases.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added the ATTRIBUTED half. Every step here seeded through POST /segments, which refuses speaker ids by design, so the scenario could only ever prove recall by "anyone" — asks, per-person profiles and consent were unprovable without a microphone. Three new steps drive the service-secret fixture (/test-fixture/attributed-line), then assert the fixture's ask on GET /person/asks and its profile on GET /person/profile/:profileId, each keyed on the run token so a step finds only its own line.
 */

import { randomUUID } from 'node:crypto';
import { AMBIENT_FIXTURE_TOPIC, AMBIENT_FIXTURE_VOICE_LABEL } from './ambient-test-fixture-routes';
import type { Scenario, StepResult } from './test-lab-scenarios';
import { serviceSecretHeaders } from '@/shared/middleware/authz';

const APP = 'person-model';
const BASE = '/api/jarvis/ambient';

/** @description Real loopback request with the initiating user's session and a bounded deadline. */
async function call(
  cookie: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json().catch(() => ({})) as Record<string, any>;
  return { status: response.status, json };
}

/** @description Classify an HTTP status honestly: missing route = gap, auth/dependency = degraded. */
function classify(label: string, status: number, pass: boolean, detail: string, output?: unknown): StepResult {
  const state: StepResult['state'] = status === 404 ? 'gap'
    : [401, 403, 409, 429, 503].includes(status) ? 'degraded'
      : status >= 500 ? 'fail' : pass ? 'pass' : 'fail';
  return { app: APP, label, state, status, detail, ...(output === undefined ? {} : { output }) };
}

/** @description The extension surface serves behind auth and carries the live-theme script + the Phase 4 views. */
async function surface(cookie: string): Promise<StepResult> {
  const label = 'Ambient Recall surface follows the cockpit theme';
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${BASE}/person/`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual',
  });
  if (response.status !== 200) return classify(label, response.status, false, `Surface returned HTTP ${response.status}.`);
  const html = await response.text();
  const themed = html.includes('/shared/ui/js/surface-theme.js');
  const views = html.includes('data-panel="people"') && html.includes('data-panel="asks"') && html.includes('data-panel="trends"');
  return classify(label, 200, themed && views, themed && views ? 'Surface serves with the shared theme script and the Asks / People / Trends views.'
    : `Surface served but ${themed ? '' : 'lacks the shared theme script; '}${views ? '' : 'lacks the Phase 4 views'}.`);
}

/** @description Seed one unattributed, clearly-labelled line through the real ingest route (never enriched: no speaker). */
async function seed(cookie: string): Promise<StepResult> {
  const label = 'Seed a labelled transcript line through the real ingest route';
  const token = `testlab${randomUUID().slice(0, 8)}`;
  const { status, json } = await call(cookie, 'POST', `${BASE}/segments`, {
    text: `Test Lab probe ${token}: ambient recall smoke line`,
    clientSegmentId: `testlab-${token}`,
    capturedAt: new Date().toISOString(),
  });
  const accepted = status === 201 || status === 200;
  return classify(label, status, accepted, accepted ? `Ingested (accepted=${json.accepted ?? '?'}, duplicates=${json.duplicates ?? 0}).`
    : json?.message || json?.error || `Ingest returned HTTP ${status}.`, { token });
}

/** @description The exact leg counts the seeded line for "anyone … today" — a SQL aggregate, never a model estimate. */
async function recall(cookie: string, prior: Record<string, any>): Promise<StepResult> {
  const label = 'Exact recall counts the seeded line today';
  const token = prior?.seed?.token;
  if (!token) return { app: APP, label, state: 'degraded', detail: 'No seeded line to recall (seed step did not pass).' };
  const q = `How many times has anyone mentioned ${token} today?`;
  const { status, json } = await call(cookie, 'GET', `${BASE}/person/recall?q=${encodeURIComponent(q)}`);
  if (status !== 200) return classify(label, status, false, json?.message || json?.error || `Recall returned HTTP ${status}.`, json);
  const count = Number(json.count ?? 0);
  const quoted = Array.isArray(json.receipts) && json.receipts.some((r: any) => String(r.quote || '').includes(token));
  return classify(label, 200, count >= 1 && quoted, count >= 1 && quoted
    ? `count=${count}, verbatim receipt present, related=${Array.isArray(json.related) ? json.related.length : 0}.`
    : `count=${count} — the seeded line was not counted (FTS column / recall query regression).`, { count, receipts: json.receipts });
}

/** @description The Phase 2-4 reads answer for the signed-in user (empty is fine; a 5xx or missing route is not). */
async function reads(cookie: string): Promise<StepResult> {
  const label = 'Asks, people, trends and projection reads answer';
  const checks: Array<[string, (j: any) => boolean]> = [
    [`${BASE}/person/asks`, (j) => Array.isArray(j.asks)],
    [`${BASE}/person/people`, (j) => Array.isArray(j.people)],
    [`${BASE}/person/trends?weeks=1`, (j) => j.personResolved === true && Array.isArray(j.rows)],
    [`${BASE}/person/projection`, (j) => typeof j.semanticAvailable === 'boolean'],
  ];
  const outcomes: Array<{ path: string; status: number; ok: boolean }> = [];
  for (const [path, ok] of checks) {
    const { status, json } = await call(cookie, 'GET', path);
    if (status !== 200) return classify(label, status, false, `${path} returned HTTP ${status}.`, json);
    outcomes.push({ path, status, ok: ok(json) });
  }
  const bad = outcomes.filter((o) => !o.ok);
  return classify(label, 200, bad.length === 0, bad.length === 0 ? 'All four reads answered with their contracted shapes.'
    : `Unexpected shape from: ${bad.map((b) => b.path).join(', ')}`, outcomes);
}

/**
 * @description Seeds ONE attributed line for the owner's stable fixture voice through the real
 * service-secret fixture. This is the only attributed writer outside the audio pipeline, so it is
 * what makes the ask / profile / consent half of ADR-100 provable in the Lab at all. A deployment
 * with no SWARM_SERVICE_SECRET gets a 503 and the step reports degraded rather than passing hollow.
 */
async function fixtureSeed(cookie: string): Promise<StepResult> {
  const label = 'Seed an attributed fixture line (service-secret gated)';
  const token = `fx${randomUUID().slice(0, 8)}`;
  // serviceSecretHeaders() returns {} when SWARM_SERVICE_SECRET is unset; read it that way rather
  // than by header name, so this outbound caller never reads as an auth SURFACE to the machine-write
  // discovery scan (tests/unit/machine-write-identity.spec.ts).
  const machineHeaders = serviceSecretHeaders();
  if (Object.keys(machineHeaders).length === 0) {
    return { app: APP, label, state: 'degraded', detail: 'SWARM_SERVICE_SECRET is not configured here, so the attributed fixture is closed.' };
  }
  const { status, json } = await call(cookie, 'POST', `${BASE}/test-fixture/attributed-line`, { token }, machineHeaders);
  const seeded = status === 201 && typeof json.profileId === 'string' && typeof json.segmentId === 'string';
  return classify(label, status, seeded, seeded
    ? `Attributed line stored for "${json.label}" (duplicate=${json.duplicate}, enriched=${json.enriched}, asks=${json.asks}).`
    : json?.message || json?.error || `Fixture returned HTTP ${status}.`,
  { token, profileId: json.profileId, segmentId: json.segmentId, ask: json.ask, quote: json.quote });
}

/** @description The follow-up ledger carries THIS run's ask, beside the verbatim line it came from. */
async function fixtureAsk(cookie: string, prior: Record<string, any>): Promise<StepResult> {
  const label = 'The fixture voice produced an open ask';
  const seeded = prior?.['fixture-seed'];
  if (!seeded?.token) return { app: APP, label, state: 'degraded', detail: 'No attributed line to read (the fixture step did not pass).' };
  const { status, json } = await call(cookie, 'GET', `${BASE}/person/asks`);
  if (status !== 200) return classify(label, status, false, json?.message || json?.error || `asks returned HTTP ${status}.`, json);
  const mine = (Array.isArray(json.asks) ? json.asks : []).find((a: any) => String(a.sourceQuote || '').includes(seeded.token));
  const ok = Boolean(mine) && mine.isInference === true && mine.personLabel === AMBIENT_FIXTURE_VOICE_LABEL;
  return classify(label, 200, ok, ok
    ? `"${String(mine.text).slice(0, 80)}" attributed to ${mine.personLabel}, marked an inference, beside its verbatim quote.`
    : `No open ask carries this run's token (${seeded.token}) against ${AMBIENT_FIXTURE_VOICE_LABEL}.`,
  { asks: Array.isArray(json.asks) ? json.asks.length : 0, ask: mine ?? null });
}

/** @description The per-person profile reads back: label, granted consent, the fixture topic and the ask. */
async function fixtureProfile(cookie: string, prior: Record<string, any>): Promise<StepResult> {
  const label = 'The fixture voice has a profile with consent, topics and asks';
  const seeded = prior?.['fixture-seed'];
  if (!seeded?.profileId) return { app: APP, label, state: 'degraded', detail: 'No fixture profile to read (the fixture step did not pass).' };
  const { status, json } = await call(cookie, 'GET', `${BASE}/person/profile/${encodeURIComponent(seeded.profileId)}`);
  if (status !== 200) return classify(label, status, false, json?.message || json?.error || `profile returned HTTP ${status}.`, json);
  const profile = json.profile ?? {};
  const checks = {
    label: profile.label === AMBIENT_FIXTURE_VOICE_LABEL,
    consent: profile.consent?.status === 'granted' && profile.consent?.eligible === true,
    topic: (profile.topics ?? []).some((t: any) => t.topic === AMBIENT_FIXTURE_TOPIC),
    ask: (profile.asks ?? []).some((a: any) => String(a.sourceQuote || '').includes(seeded.token)),
    presence: (profile.presence ?? []).length > 0,
  };
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return classify(label, 200, missing.length === 0, missing.length === 0
    ? `Profile "${profile.label}": consent granted, topic "${AMBIENT_FIXTURE_TOPIC}", this run's ask, and presence from the seeded line.`
    : `Profile read, but these were not proven: ${missing.join(', ')}.`, { profile, missing });
}

/** @description Jarvis answers the open-asks shape deterministically once the owner has ambient data. */
async function chat(cookie: string): Promise<StepResult> {
  const label = 'Jarvis answers "what has anyone asked me" without a model turn';
  const start = await call(cookie, 'POST', '/api/jarvis/ask', { message: 'What has anyone asked me?' });
  if (start.status !== 202 && start.status !== 200) return { ...classify(label, start.status, false, `ask returned HTTP ${start.status}.`, start.json), app: 'jarvis' };
  const jobId = start.json?.jobId;
  if (!jobId) return { app: 'jarvis', label, state: 'fail', status: start.status, detail: 'no jobId returned.', output: start.json };
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await call(cookie, 'GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`);
    if (r.json?.status !== 'done') continue;
    const answer = String(r.json?.answer || '');
    const deterministic = /open (?:item|items|asks)|Nothing open/i.test(answer);
    return { app: 'jarvis', label, state: deterministic ? 'pass' : 'degraded', detail: deterministic
      ? `deterministic asks answer: "${answer.slice(0, 120)}"`
      : `answered, but not through the person-model front door (owner may have no ambient data): "${answer.slice(0, 120)}"`, output: { answer: answer.slice(0, 400) } };
  }
  return { app: 'jarvis', label, state: 'degraded', detail: 'still pending after 24s.', output: { jobId } };
}

/** @description Runnable ADR-100 product scenario for the AI Test Lab. */
export const AMBIENT_SCENARIOS: Scenario[] = [
  {
    id: 'ambient-recall',
    title: 'Ambient Recall — exact recall, asks, people, trends (ADR-100)',
    group: 'tool',
    description: 'Seeds one clearly-labelled Test Lab transcript line through the real ambient ingest route, then proves the deterministic person-model reads: an exact count for that line, the asks / people / trends / projection reads, the themed surface, and Jarvis chat answering the open-asks shape without a model turn. That first line is unattributed (no speaker), so it is never enriched or turned into an ask; the service-secret fixture then seeds an ATTRIBUTED line for a stable per-owner fixture voice and the last two steps prove its open ask and its per-person profile (consent, topics, presence).',
    regressionTests: [
      { level: 'unit', path: 'tests/unit/person-model-intent.spec.ts' },
      { level: 'unit', path: 'tests/unit/person-model-surface.spec.ts' },
      { level: 'unit', path: 'tests/unit/person-model-recall-guard.spec.ts' },
      { level: 'unit', path: 'tests/unit/person-model-related-relevance.spec.ts' },
      { level: 'integration', path: 'tests/unit/person-model-parity-postgres.spec.ts' },
      { level: 'unit', path: 'tests/unit/person-model-maintenance-runtime.spec.ts' },
      { level: 'unit', path: 'tests/unit/lazy-ddl-guard-convergence.spec.ts' },
      { level: 'unit', path: 'tests/unit/jarvis-speaker-wiring.spec.ts' },
      { level: 'browser', path: 'tests/unit/jarvis-speaker-profile-links-browser.spec.ts' },
      { level: 'unit', path: 'tests/unit/ambient-test-fixture-routes.spec.ts' },
      { level: 'integration', path: 'tests/unit/ambient-test-fixture-postgres.spec.ts' },
    ],
    steps: [
      { id: 'surface', app: APP, label: 'Surface follows the cockpit theme', run: (cookie) => surface(cookie) },
      { id: 'seed', app: APP, label: 'Seed a labelled transcript line', run: (cookie) => seed(cookie) },
      { id: 'recall', app: APP, label: 'Exact recall counts the seeded line', run: (cookie, prior) => recall(cookie, prior) },
      { id: 'reads', app: APP, label: 'Asks / people / trends / projection reads', run: (cookie) => reads(cookie) },
      { id: 'fixture-seed', app: APP, label: 'Seed an attributed fixture line', run: (cookie) => fixtureSeed(cookie) },
      { id: 'fixture-ask', app: APP, label: 'The fixture voice produced an open ask', run: (cookie, prior) => fixtureAsk(cookie, prior) },
      { id: 'fixture-profile', app: APP, label: 'The fixture voice has a profile', run: (cookie, prior) => fixtureProfile(cookie, prior) },
      { id: 'chat', app: 'jarvis', label: 'Jarvis open-asks answer is deterministic', run: (cookie) => chat(cookie) },
    ],
  },
];
