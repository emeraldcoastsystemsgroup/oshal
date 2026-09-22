/**
 * AI Test Lab — scenario registry + step runners (ADR-063).
 *
 * Split out of test-lab-routes.ts so the router stays thin and this data-heavy registry has room to
 * grow to full app coverage. Four scenario groups:
 *   - visual   — deterministic: render each of the 8 visual KINDS via the real renderer and prove the
 *                rich-display pipeline works, independent of any live account. Returns the SVG url so
 *                the surface shows the actual image ("ask for weather, see the image").
 *   - tool     — one step: hit an app's primary read endpoint and assert a sane response.
 *   - jarvis   — fire a command at /api/jarvis/ask; for visual-eligible asks ALSO assert the live
 *                result materialized a real /api/jarvis/visuals/<uuid> image (answered-without-visual
 *                is surfaced as `degraded` — the exact "loss of functionality" regression signal).
 *   - coupled  — multi-step mix-and-match across apps (the lab orchestrates; Jarvis can't chain).
 *
 * Result states stay honest: pass | degraded | gap | fail. Surfacing degraded/gap is the point.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 18 | maintainer@emeraldcoastsystemsgroup.com | Attach regression tests to the jarvis-routing scenario. It had none, so the two guards behind every step in it - the /ask session-ownership gate and the deterministic provider-intent routing - were invisible from the Lab, and the ownership guard sat red for days with nothing pointing at it.
 * 17 | maintainer@emeraldcoastsystemsgroup.com | Register the ADR-100 Ambient Recall scenario (exact recall, asks/people/trends reads, deterministic Jarvis asks answer).
 * 16 | maintainer@emeraldcoastsystemsgroup.com | Register isolated nightly, provisioning and authoritative bot initialization coverage.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | Register installed-case discovery, connector callback boundaries and multi-store control regression suites.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | Register artifact scenarios and expose categorized regression suites in the existing Lab catalog.
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted registry from
 *            | test-lab-routes.ts; added the deterministic `visual` group, live Jarvis visual
 *            | assertions, and a compact smoke() builder for full per-app coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the storage smoke +
 *            | the coupled-travel-deck save-target step — /api/storage carved to the app
 *            | store (ADR-085 Wave 2); the test server installs no packages.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the presentations
 *            | smoke + the rest of the coupled-travel-deck scenario — AI Office carved to the
 *            | app store (ADR-085 Wave 2); travel keeps its own smoke.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed the feeds smoke —
 *            | the Feeds /api/feeds surface carved to the app store (ADR-085 Wave 3); the
 *            | feeds-indexing engine + feeds-curator node stay framework-resident.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Removed the identity smoke —
 *            | the Identity Hub /api/identity surface carved to the app store (ADR-085 Wave 3);
 *            | the identity-advisor inline node + the connector hub stay framework-resident.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Removed the travel smoke —
 *            | the Travel /api/travel surface carved to the app store (ADR-085 Wave 3); the
 *            | price engine + fare-watch cron + travel-concierge node stay framework-resident.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Removed the video smoke —
 *            | the Video Studio /api/video surface carved to the app store (ADR-085 Wave 3);
 *            | the series conductor engine + the two inline nodes stay framework-resident.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Removed the vids smoke —
 *            | the Vids / Creative Studio /api/vids surface carved to the app store (ADR-085
 *            | Wave 3); the vids-operator desktop worker + remote-client mesh stay core.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Removed the gov-contracting
 *            | smoke — the /api/gov-contracting surface carved to the app store (ADR-085
 *            | Wave 3); the SAM-scan cron engine + python engine + capture bots stay core.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Removed the email smoke and
 *            | re-fixtured the coupled-briefing inbox leg onto the kernel-resident content
 *            | signals read — the /api/email surface carved to the app store (ADR-085 Wave 3);
 *            | the comms bot + email-send machinery + inbox-ingest engine stay core.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Removed the kalshi smoke —
 *            | the /api/kalshi surface carved to the app store (ADR-085 Wave 3); the
 *            | prediction-markets engine + connector + calibration CLIs stay core.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Removed the world smoke —
 *            | the /api/world surface carved to the app store (ADR-085 Wave 3); the
 *            | world-data engine + world-schedule-dispatch + oshal-world.js CLI stay core.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Removed the trading smoke +
 *            | the coupled-briefing positions leg — the four /api/trading* surfaces carved to
 *            | the app store (ADR-085 Wave 3); the trading engine + all 8 autopilot dispatch/
 *            | reconcile loops + the trading-bot/weather-bot nodes stay framework-resident.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Registered the data-model explorer card (DATA_MODEL_SCENARIOS): a read-only operator step over /api/admin/data-model with its unit, integration and browser suites. Guard: tests/unit/data-model-test-lab-registration.spec.ts.
 * ---------------------------------------------------------------------------
 * Appearance | maintainer@emeraldcoastsystemsgroup.com | Register the read-only Workspace asset check and linked actual browser proof.
 * 19 | maintainer@emeraldcoastsystemsgroup.com | Registered the Notifications per-channel account tier card (NOTIFICATION_SCENARIOS): a read-only step over GET /api/notify/prefs with its route, page and sender suites. Guard: tests/unit/test-lab-notification-registration.spec.ts.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Registered the 'provider-switch' scenario ("a bot's LLM provider is a row in a table"): a read-only probe of the fleet-default row + snapshot and of the rung every bot reports through /api/agents, failing on a switch-refused bot; regressionTests attach the unit/integration/browser guards that ship with the switch.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Attached tests/unit/dispatch-switch-row-stamping.spec.ts to the 'provider-switch' regressionTests: the tier-1 dispatch-stamping guard (a fleet or per-bot row reaching a DEDICATED bot node), added after review found that rung unguarded.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Attached the fallback-ORDER guards to the provider-switch regressionTests: provider-fallback-chain, antigravity-cli-harness and bot-node-config-bootstrap. Migration 148 added fallback_order to the same row the scenario already reads, and its guards shipped registered nowhere - a test file on disk is not Test Lab registration.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Attached the database-less completion floor guard (CKR-8): a bot node with no database repository resolved to zero tools including attempt_completion, so it could not say it was finished. The Helm federated bot-pod topology ships database-less on purpose.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Registered the messaging-channels card (CHANNEL_SCENARIOS): a read-only step over GET /api/channels that checks the surface reports which inbound channels this deployment has wired and which identities are bound to the caller. Guard: tests/unit/test-lab-channel-registration.spec.ts.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Registered the remote-node binding card (DEVICE_SCENARIOS): a read-only step over GET /api/remote-clients that checks the surface can say, per computer, whether it finished enrolling and who it is bound to. A node bound to nobody heartbeats like a working one and receives no owner-scoped work, and nothing in the cockpit used to say so. Guard: tests/unit/device-ownership-visible.spec.ts.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Attached the hand-off guards to 'jarvis-routing' regressionTests: jarvis-build-handoff (a build directive is filed with the swarm without a model turn, exactly once) and jarvis-task-complete-notify (a finished task reaches its owner). Both ship with the hand-off work and a test file on disk is not Test Lab registration. No live step was added for the build path on purpose - firing a real build directive at the deployment would open a real ticket on every lab run.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Attached tests/unit/provider-model-catalog.spec.ts to the 'provider-switch' regressionTests. The scenario already covers which PROVIDER serves a bot; the MODEL on the same row was validated against nothing at all, so a configured id absent from provider-definitions was accepted silently and its real call recorded at $0. A test file on disk is not Test Lab registration.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Attached openai-compat-tool-call-extraction to 'jarvis-routing' regressionTests. Jarvis turns run through the OpenAI-compatible adapter, and a turn the model spent attempting a tool call was being thrown away there - the guard carries the response shapes captured live from the failure, so it belongs to this scenario rather than sitting unregistered on disk.
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Registered the 'byo-hot-fallback' scenario (operator decision 2026-09-22): a read-only probe of the configured hot-fallback chain and each rung's readiness through the Settings llm-default route, with the two guards that prove the same-endpoint replay and the operator-only fallback attached as regressionTests. A test file on disk is not Test Lab registration.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Attached direct-path-declared-tool-boundary to 'jarvis-routing' regressionTests. The sibling of entry 28: that guard covers a tool call being READ, this one covers the tools being DECLARED at all and the boundary around them being enforced - the direct conversational path told the model it had N tools and handed the provider none, which is why an ask for live information answered "go to the application". Registered here because it is the same Jarvis turn, and a spec on disk is not Test Lab registration.
 * @module test-lab-scenarios
 */

import { ARTIFACT_SCENARIOS } from './test-lab-artifact-scenarios';
import { INSTALLATION_SCENARIOS } from './test-lab-installation-scenarios';
import { APPEARANCE_SCENARIOS } from './test-lab-appearance-scenarios';
import { DASHBOARD_SCENARIOS } from './test-lab-dashboard-scenarios';
import { CONNECTOR_OAUTH_SCENARIOS } from './test-lab-connector-scenarios';
import { APP_REGISTRY_SCENARIOS } from './test-lab-app-registry-scenarios';
import { AUTHORIZATION_SCENARIOS } from './test-lab-authorization-scenarios';
import { AUTONOMOUS_SCENARIOS } from './test-lab-autonomous-scenarios';
import { AMBIENT_SCENARIOS } from './test-lab-ambient-scenarios';
import { DATA_MODEL_SCENARIOS } from './test-lab-data-model-scenarios';
import { NOTIFICATION_SCENARIOS } from './test-lab-notification-scenarios';
import { CHANNEL_SCENARIOS } from './test-lab-channel-scenarios';
import { DEVICE_SCENARIOS } from './test-lab-device-scenarios';
import { renderCatalogVisual, VISUAL_CATALOG } from './test-lab-visual-catalog';

const SELF_PORT = process.env.PORT || '5000';
const SELF_BASE = `http://localhost:${SELF_PORT}`;
/** The exact owner-scoped Jarvis artifact URL shape the UI trusts; the lab asserts the same. */
const JARVIS_VISUAL_URL = /^\/api\/jarvis\/visuals\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type State = 'pass' | 'degraded' | 'gap' | 'fail';

/** One rendered/asserted step. `visual` (when set) makes the surface show the produced image. */
export interface StepResult {
  app: string;
  label: string;
  state: State;
  status?: number;
  detail: string;
  output?: any;
  visual?: { url: string; alt: string; kind: string };
}

type Assert = (json: any, status: number) => Partial<StepResult> & { state: State };

export interface Scenario {
  id: string;
  title: string;
  group: 'visual' | 'tool' | 'jarvis' | 'coupled';
  description: string;
  regressionTests?: Array<{ level: 'unit' | 'integration' | 'browser'; path: string }>;
  steps: Array<{ id: string; app: string; label: string; run: (cookie: string, prior: Record<string, any>) => Promise<StepResult> }>;
}

// (isoPlusDays helper removed with the travel smoke — its only consumer, ADR-085 Wave 3.)

/** A loopback JSON call to a sibling app route, forwarding the caller's session cookie. */
async function call(cookie: string, method: string, p: string, body?: any): Promise<{ status: number; json: any }> {
  const res = await fetch(`${SELF_BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

/** A loopback binary fetch (for image artifacts): returns status, content-type and byte length. */
async function fetchRaw(cookie: string, p: string): Promise<{ status: number; contentType: string; bytes: number }> {
  const res = await fetch(`${SELF_BASE}${p}`, { headers: cookie ? { cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: String(res.headers.get('content-type') || ''), bytes: buf.byteLength };
}

/** Run one HTTP step with resilient state classification. `assert` refines a 2xx response. */
export async function step(cookie: string, app: string, label: string, method: string, p: string, body: any, assert?: Assert): Promise<StepResult> {
  let res: { status: number; json: any };
  try { res = await call(cookie, method, p, body); }
  catch (e: any) { return { app, label, state: 'fail', detail: `request failed: ${e?.message || e}` }; }
  const { status, json } = res;
  if (status === 404) return { app, label, state: 'gap', status, detail: `No endpoint at ${method} ${p} — capability missing or route moved.` };
  if ([400, 422].includes(status)) return { app, label, state: 'degraded', status, detail: json?.message || json?.error || `Reachable, but rejected the smoke input (HTTP ${status}) — needs valid params.`, output: json };
  if ([401, 403, 409, 429].includes(status)) return { app, label, state: 'degraded', status, detail: json?.message || json?.error || `Needs a connected account, scope, or active session (HTTP ${status}).`, output: json };
  if (status === 503) return { app, label, state: 'degraded', status, detail: json?.message || json?.error || 'Optional dependency not configured (HTTP 503).', output: json };
  if (status >= 500) return { app, label, state: 'fail', status, detail: `Server error HTTP ${status}.`, output: json };
  const base: StepResult = { app, label, status, state: 'pass', detail: 'OK', output: json };
  if (assert) { try { return { ...base, ...assert(json, status) }; } catch (e: any) { return { ...base, state: 'fail', detail: `assertion error: ${e?.message || e}` }; } }
  return { ...base, state: status === 202 ? 'degraded' : 'pass', detail: status === 202 ? 'Dispatched (async).' : 'OK' };
}

/** Fire a command at Jarvis and poll the async result. Optionally require a live visual artifact. */
export async function jarvisStep(cookie: string, label: string, message: string, expectVisual = false): Promise<StepResult> {
  const start = await call(cookie, 'POST', '/api/jarvis/ask', { message });
  if (start.status === 404) return { app: 'jarvis', label, state: 'gap', status: 404, detail: 'Jarvis /ask endpoint not found.' };
  if (start.status >= 400) return { app: 'jarvis', label, state: start.status === 401 ? 'degraded' : 'fail', status: start.status, detail: `ask failed HTTP ${start.status}.`, output: start.json };
  const jobId = start.json?.jobId;
  if (!jobId) return { app: 'jarvis', label, state: 'fail', status: start.status, detail: 'no jobId returned.', output: start.json };
  // Visual asks route through a ticket → bot → provider → delayed completion, so poll longer.
  const attempts = expectVisual ? 24 : 12;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await call(cookie, 'GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`);
    if (r.json?.status !== 'done') continue;
    const answer = String(r.json?.answer || '').trim();
    const dispatched = Array.isArray(r.json?.dispatched) ? r.json.dispatched.length : 0;
    if (expectVisual) return classifyVisualResult(cookie, label, r.json, answer);
    if (answer || dispatched) return { app: 'jarvis', label, state: 'pass', detail: `routed${dispatched ? ` + dispatched ${dispatched} task(s)` : ''}: "${answer.slice(0, 120)}"`, output: { answer: answer.slice(0, 400), dispatched } };
    return { app: 'jarvis', label, state: 'degraded', detail: 'done but empty answer.', output: r.json };
  }
  return { app: 'jarvis', label, state: 'degraded', detail: `still pending after ${attempts * 2}s (Jarvis accepted it; long-running or no live bot node).`, output: { jobId } };
}

/** Validate a live Jarvis result's `visual`, fetch the artifact, and classify the delivery honestly. */
async function classifyVisualResult(cookie: string, label: string, result: any, answer: string): Promise<StepResult> {
  const visual = result?.visual;
  if (!visual || !visual.url) {
    return { app: 'jarvis', label, state: 'degraded', detail: answer ? `answered WITHOUT a visual — live provider unavailable or rich delivery regressed: "${answer.slice(0, 100)}"` : 'done, no answer and no visual.', output: { answer: answer.slice(0, 200) } };
  }
  if (!JARVIS_VISUAL_URL.test(String(visual.url))) {
    return { app: 'jarvis', label, state: 'fail', detail: `visual url is not an owner-scoped artifact URL: ${String(visual.url).slice(0, 80)}`, output: { visual } };
  }
  const img = await fetchRaw(cookie, visual.url);
  if (img.status !== 200) return { app: 'jarvis', label, state: 'fail', status: img.status, detail: `visual metadata present but artifact fetch returned HTTP ${img.status}.`, output: { visual } };
  if (!/image\/svg\+xml/i.test(img.contentType) || img.bytes < 200) {
    return { app: 'jarvis', label, state: 'fail', detail: `artifact is not a real SVG (type=${img.contentType}, ${img.bytes} bytes).`, output: { visual } };
  }
  return {
    app: 'jarvis', label, state: 'pass',
    detail: `live visual delivered (${visual.kind}, ${img.bytes} bytes SVG): "${answer.slice(0, 90)}"`,
    output: { answer: answer.slice(0, 200), kind: visual.kind, bytes: img.bytes },
    visual: { url: String(visual.url), alt: String(visual.alt || answer.slice(0, 120)), kind: String(visual.kind || 'image') },
  };
}

/** Deterministically render one visual KIND through the real renderer and prove the SVG is valid. */
export function renderVisualStep(kind: string): StepResult {
  const app = 'visual-response';
  try {
    const rendered = renderCatalogVisual(kind);
    if (!rendered) return { app, label: kind, state: 'gap', detail: `no catalog entry for kind ${kind}.` };
    const svg = rendered.content.toString('utf8');
    const valid = svg.includes('<svg') && rendered.mimeType === 'image/svg+xml' && rendered.content.byteLength > 200;
    if (!valid) return { app, label: kind, state: 'fail', detail: `renderer returned invalid output for ${kind}.` };
    return {
      app, label: kind, state: 'pass',
      detail: `rendered ${rendered.content.byteLength}-byte SVG (${rendered.width}×${rendered.height}).`,
      visual: { url: `/api/test-lab/visual/${encodeURIComponent(kind)}.svg`, alt: rendered.alt, kind },
    };
  } catch (e: any) {
    return { app, label: kind, state: 'fail', detail: `renderer threw for ${kind}: ${e?.message || e}` };
  }
}

/** Compact builder for a one-step tool smoke. */
function smoke(app: string, title: string, description: string, path: string, assert?: Assert, method = 'GET', body?: any): Scenario {
  return {
    id: `smoke-${app}`, title, group: 'tool', description,
    steps: [{ id: 'primary', app, label: `${method} ${path}`, run: (c) => step(c, app, title, method, path, body, assert) }],
  };
}

/** Non-empty-array assert factory: pass when `field` is a non-empty array, degraded when empty. */
function arrayAssert(field: string, noun: string): Assert {
  return (j) => {
    const arr = j?.[field];
    if (!Array.isArray(arr)) return { state: 'gap', detail: `unexpected shape (no '${field}' array).` };
    return arr.length ? { state: 'pass', detail: `${arr.length} ${noun}`, output: arr.slice(0, 5) } : { state: 'degraded', detail: `reachable but no ${noun} yet.` };
  };
}

// ── Scenario registry ────────────────────────────────────────────────────────
export const SCENARIOS: Scenario[] = [
  ...ARTIFACT_SCENARIOS,
  ...INSTALLATION_SCENARIOS,
  ...APPEARANCE_SCENARIOS,
  ...DASHBOARD_SCENARIOS,
  ...CONNECTOR_OAUTH_SCENARIOS,
  ...APP_REGISTRY_SCENARIOS,
  ...AUTHORIZATION_SCENARIOS,
  ...AUTONOMOUS_SCENARIOS,
  ...AMBIENT_SCENARIOS,
  ...DATA_MODEL_SCENARIOS,
  ...NOTIFICATION_SCENARIOS,
  ...CHANNEL_SCENARIOS,
  ...DEVICE_SCENARIOS,
  // ── Rich visuals — every kind rendered deterministically through the real renderer ──────────
  ...VISUAL_CATALOG.map((entry): Scenario => ({
    id: `visual-${entry.kind}`,
    title: entry.label,
    group: 'visual',
    description: entry.description,
    steps: [{ id: 'render', app: 'visual-response', label: `render ${entry.kind} visual`, run: async () => renderVisualStep(entry.kind) }],
  })),

  // ── Per-tool smoke tests (primary read endpoint per app) ────────────────────────────────────
  // (career-hunter smoke removed: carved to the app store, ADR-085 Wave 3 #1.)
  // (presentations smoke removed: AI Office carved to the app store, ADR-085 Wave 2 —
  //  the test server installs no packages.)
  // (storage smoke removed: carved to the app store, ADR-085 Wave 2.)
  // (email smoke removed: the Email Summarizer surface carved to the app store, ADR-085
  //  Wave 3 — the /api/email route only exists when the package is installed + active.)
  // (social smoke removed: the Social app carved to the app store, ADR-085 Wave 2 —
  //  the /api/social route only exists when the package is installed + active.)

  // (purchasing smoke removed: carved to the app store, ADR-085 Wave 2 #5.)
  // (eats smoke removed: carved to the app store, ADR-085 Wave 2 #4.)
  // (spotify smoke removed: carved to the app store, ADR-085 Wave 2 #2.)
  // (movies smoke removed: Movies & TV carved to the app store, ADR-085 Wave 2 #1 —
  //  an installed package's routes are exercised by its own package tests.)
  // (travel smoke removed: the Travel surface carved to the app store, ADR-085 Wave 3 —
  //  its route only exists when the package is installed + active.)
  // (rides smoke removed: carved to the app store, ADR-085 Wave 2 #3.)

  // Money bundle.
  // (trading smoke removed: the trading surface carved to the app store, ADR-085 Wave 3 —
  //  its routes only exist when the package is installed + active; the engine + autopilot
  //  loops stay kernel and are guarded by the tests/unit/trading-*.spec.ts family.)
  // (kalshi smoke removed: Kalshi Prediction Markets carved to the app store, ADR-085 Wave 3 —
  //  its route only exists when the package is installed + active.)
  // (Finance smoke removed: finance carved to the app store, ADR-085 —
  //  its route only exists when the package is installed + active.)
  // (Payments smoke removed: payments carved to the app store, ADR-085 —
  //  its route only exists when the package is installed + active.)

  // Personal + home bundle.
  // (identity smoke removed: the Identity Hub carved to the app store, ADR-085 Wave 3 —
  //  its route only exists when the package is installed + active.)
  // (home smoke removed: Smart Home carved to the app store, ADR-085 Wave 2 —
  //  its route only exists when the package is installed + active.)
  // (Kid Lens smoke removed: youtube-kids carved to the app store, ADR-085 —
  //  its route only exists when the package is installed + active.)

  // Media + content bundle.
  // (video smoke removed: the Video Studio /api/video surface carved to the app store,
  //  ADR-085 Wave 3 — its route only exists when the package is installed + active.)
  // (vids smoke removed: the Vids / Creative Studio /api/vids surface carved to the app
  //  store, ADR-085 Wave 3 — its route only exists when the package is installed + active.
  //  The shared vids-operator desktop worker + the remote-client mesh stay framework-resident.)
  // (feeds smoke removed: the Feeds /api/feeds surface carved to the app store, ADR-085
  //  Wave 3 — its route only exists when the package is installed + active. The feeds-indexing
  //  engine + feeds-curator node stay framework-resident.)
  smoke('content', 'Content Studio — signals', 'Read the inbox-fed content signals.',
    '/api/content/signals', undefined),
  // (world smoke removed: the World Intelligence /api/world surface carved to the app store,
  //  ADR-085 Wave 3 — its route only exists when the package is installed + active. The
  //  world-data engine + world-schedule-dispatch + the oshal-world.js CLI stay framework-resident.)

  // Knowledge + graph + search bundle.
  smoke('rag', 'RAG — collections', 'Read the available RAG collections.',
    '/api/rag/collections', undefined),
  smoke('personal-graph', 'Personal Graph — stats', 'Read the personal knowledge-graph stats (ArangoDB optional → 503).',
    '/api/personal-graph/stats', undefined),
  smoke('memory', 'Memory — knowledge summary', 'Read the swarm memory knowledge summary.',
    '/api/memory/knowledge/summary', undefined),
  smoke('search', 'Global search', 'Run the cross-app global search.',
    '/api/search?q=jobs', undefined),

  // Ops / security bundle. (The gov-contracting smoke moved out with its carve to the app
  // store, ADR-085 Wave 3 — core scenarios no longer target packaged routes.)
  smoke('security', 'Security Center — findings', 'Read live security findings (operator-gated → degraded for non-operators).',
    '/api/security/findings', undefined),
  smoke('workflow-studio', 'Workflow Studio — runs', 'Read authored workflow runs.',
    '/api/workflow-studio/runs', undefined),
  smoke('connectors', 'Connector Marketplace — catalog', 'Read the connector marketplace catalog.',
    '/api/connectors', undefined),

  // ── The LLM provider switch: per-bot row > fleet default > registry literal ────────────────────
  {
    id: 'provider-switch', title: 'LLM provider switch — the fleet default and the resolved rung per bot', group: 'tool',
    description: 'Read the fleet-default switch row (operator-gated → degraded for non-operators) and confirm every bot reports the rung that will serve its next dispatch (bot-row | fleet-default | registry-harness), plus the ordered FALLBACK chain that row carries (migration 148). Read-only: nothing here writes a row.',
    regressionTests: [
      { level: 'unit', path: 'tests/unit/bot-provider-switch.spec.ts' },
      { level: 'unit', path: 'tests/unit/bot-provider-precedence.spec.ts' },
      { level: 'unit', path: 'tests/unit/harness-resolution.spec.ts' },
      { level: 'unit', path: 'tests/unit/bot-node-provider-switch.spec.ts' },
      { level: 'unit', path: 'tests/unit/dispatch-switch-row-stamping.spec.ts' },
      { level: 'unit', path: 'tests/unit/compose-bot-provider-literal.spec.ts' },
      // The MODEL half of the same row: the provider id was validated against the runnable
      // catalog and the model against nothing, so a configured id absent from the catalog
      // was accepted in silence and its real call booked at $0.
      { level: 'unit', path: 'tests/unit/provider-model-catalog.spec.ts' },
      // The fallback ORDER half of the same row (migration 148): the chain an administrator
      // writes, and the harnesses that cannot serve as a rung of it.
      { level: 'unit', path: 'tests/unit/provider-fallback-chain.spec.ts' },
      // A node with no database repository must still be able to signal completion (CKR-8).
      { level: 'unit', path: 'tests/unit/database-less-node-completion-floor.spec.ts' },
      { level: 'unit', path: 'tests/unit/antigravity-cli-harness.spec.ts' },
      { level: 'unit', path: 'tests/unit/bot-node-config-bootstrap.spec.ts' },
      { level: 'integration', path: 'tests/unit/provider-switch-store-postgres.spec.ts' },
      { level: 'integration', path: 'tests/unit/provider-switch-routes.spec.ts' },
      { level: 'integration', path: 'tests/unit/config-runtime-precedence.spec.ts' },
      { level: 'browser', path: 'tests/unit/provider-switch-cockpit-browser.spec.ts' },
    ],
    steps: [
      { id: 'fleet', app: 'config-admin', label: '1) GET /api/agents/provider-switch — the fleet row + snapshot', run: (c) => step(c, 'config-admin', 'fleet default', 'GET', '/api/agents/provider-switch', undefined,
        (j) => {
          if (!j?.success) return { state: 'gap', detail: 'unexpected shape (no success flag).' };
          const accepted = Array.isArray(j.accepted) ? j.accepted.length : 0;
          const snapshot = j.snapshot ? `snapshot ${j.snapshot.loaded ? 'loaded' : 'NOT loaded'}, ${j.snapshot.rowCount} row(s)` : 'no snapshot installed';
          if (!accepted) return { state: 'degraded', detail: `reachable; ${snapshot}; no accepted ids yet (catalog not installed).`, output: j };
          return { state: 'pass', detail: `${j.fleetDefault ? `fleet default ${j.fleetDefault.providerId}` : 'no fleet default (registry literal)'}; ${snapshot}; ${accepted} accepted id(s)`, output: { fleetDefault: j.fleetDefault, snapshot: j.snapshot } };
        }) },
      { id: 'rungs', app: 'config-admin', label: '2) GET /api/agents — every bot names its rung', run: (c) => step(c, 'config-admin', 'resolved rungs', 'GET', '/api/agents', undefined,
        (j) => {
          const agents: Array<Record<string, unknown>> = Array.isArray(j?.agents) ? j.agents : [];
          if (!agents.length) return { state: 'degraded', detail: 'no agents listed.' };
          const counts: Record<string, number> = {};
          for (const a of agents) { const k = String(a.providerSource ?? 'unknown'); counts[k] = (counts[k] ?? 0) + 1; }
          const refused = counts['switch-refused'] ?? 0;
          const unknown = counts.unknown ?? 0;
          const summary = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ');
          if (refused) return { state: 'fail', detail: `${refused} bot(s) hold a switch row this build cannot run: ${summary}`, output: counts };
          if (unknown === agents.length) return { state: 'gap', detail: 'no bot reports providerSource — the switch report is missing.', output: counts };
          return { state: 'pass', detail: summary, output: counts };
        }) },
    ],
  },

  // ── The BYO same-endpoint retry + the operator's hot fallback chain ─────────────────────────
  {
    id: 'byo-hot-fallback', title: 'BYO endpoint retry + the operator\'s hot fallback chain', group: 'tool',
    description: 'Read-only: GET /api/settings/llm-default reports the CONFIGURED hot-fallback chain (the switch row\'s fallback_order, ADR-162 precedence; default openai-codex → claude-code when no record carries one) and each rung\'s readiness (login present and unexpired, key present) from the token-free stored status. No turn is spent here; the same-endpoint replay, the operator-only gate and the fallback itself are proven by the registered guards.',
    regressionTests: [
      // The retry wraps the PROVIDER call (one saved user message, one error broadcast), keyed on
      // an explicitly chosen endpoint only, across the real cockpit router and a loopback endpoint.
      { level: 'integration', path: 'tests/unit/byo-same-endpoint-retry.spec.ts' },
      // The operator-only, readiness-gated, one-pass walk of the configured chain, the marker, the
      // WARN line, the not-ready error, and the PUT that re-orders the chain with no restart.
      { level: 'integration', path: 'tests/unit/byo-hot-fallback.spec.ts' },
    ],
    steps: [
      { id: 'chain', app: 'settings', label: '1) GET /api/settings/llm-default — the chain and each rung\'s readiness', run: (c) => step(c, 'settings', 'hot fallback', 'GET', '/api/settings/llm-default', undefined,
        (j) => {
          const hf = j?.hotFallback;
          if (!hf || !hf.chain) return { state: 'gap', detail: 'unexpected shape (no hotFallback block).' };
          const order: string[] = Array.isArray(hf.chain.order) ? hf.chain.order : [];
          const rungs: Array<{ providerId: string; ready: boolean; reason: string }> = Array.isArray(hf.rungs) ? hf.rungs : [];
          if (!order.length) return { state: 'degraded', detail: `no fallback rung configured (chain source: ${hf.chain.source}) — set fallbackOrder on the fleet-default switch row.`, output: hf };
          const ready = rungs.filter((r) => r.ready).map((r) => r.providerId);
          const cold = rungs.filter((r) => !r.ready).map((r) => `${r.providerId}: ${r.reason}`);
          const gate = hf.gate?.available ? 'gates admit this caller' : 'gates do not admit this caller (demo + operator only)';
          if (!ready.length) return { state: 'degraded', detail: `chain ${order.join(' → ')} (${hf.chain.source}); NO rung ready — ${cold.join('; ')}; ${gate}.`, output: hf };
          return { state: 'pass', detail: `chain ${order.join(' → ')} (${hf.chain.source}); ready: ${ready.join(', ')}${cold.length ? `; not ready: ${cold.join('; ')}` : ''}; ${gate}.`, output: { chain: hf.chain, rungs, gate: hf.gate } };
        }) },
    ],
  },

  // ── Jarvis routing + live visual delivery ───────────────────────────────────────────────────
  {
    id: 'jarvis-routing', title: 'Jarvis routing — does it understand each ask?', group: 'jarvis',
    description: 'Fire each command at Jarvis and confirm it answers or dispatches.',
    regressionTests: [
      { level: 'integration', path: 'tests/unit/jarvis-ask-session-ownership.spec.ts' },
      { level: 'integration', path: 'tests/unit/jarvis-provider-intent-routing.spec.ts' },
      { level: 'integration', path: 'tests/unit/jarvis-build-handoff.spec.ts' },
      { level: 'unit', path: 'tests/unit/jarvis-task-complete-notify.spec.ts' },
      { level: 'unit', path: 'tests/unit/openai-compat-tool-call-extraction.spec.ts' },
      { level: 'integration', path: 'tests/unit/direct-path-declared-tool-boundary.spec.ts' },
    ],
    steps: [
      { id: 'j-jobs', app: 'jarvis', label: '"What are my top job opportunities right now?"', run: (c) => jarvisStep(c, 'top jobs', 'What are my top job opportunities right now?') },
      { id: 'j-fly', app: 'jarvis', label: '"Search flights from JFK to London next month."', run: (c) => jarvisStep(c, 'search flights', 'Search flights from JFK to London next month.') },
      { id: 'j-gift', app: 'jarvis', label: '"Find a Lego set I could buy as a gift."', run: (c) => jarvisStep(c, 'find gift', 'Find a Lego set I could buy as a gift.') },
    ],
  },
  {
    id: 'jarvis-visual', title: 'Jarvis rich delivery — ask, then SEE the image', group: 'jarvis',
    description: 'The flagship contract: a provider-bound ask must come back with a real, owner-scoped visual artifact — not just text. Answered-without-a-visual is flagged degraded.',
    steps: VISUAL_CATALOG.filter((e) => e.liveAsk).map((e) => ({
      id: `jv-${e.kind}`, app: 'jarvis', label: `"${e.liveAsk}" → ${e.kind} image`,
      run: (c: string) => jarvisStep(c, `${e.kind} visual`, e.liveAsk!, true),
    })),
  },

  // (Coupled "job pack → deck → save → email" scenario removed: career-hunter carved to the
  //  app store, ADR-085 Wave 3 #1 — its jobs/resume steps hit the packaged /api/career-hunter routes.)

  // (Coupled "gift for Jason (Shop)" scenario removed: purchasing carved to the app store,
  //  ADR-085 Wave 2 #5 — its find + checkout steps hit the packaged /api/purchasing routes.)

  // ── Coupled multi-app scenario 3: daily briefing pull (content signals + ticket queue) ───────
  { id: 'coupled-briefing', title: 'Daily briefing — signals + work queue', group: 'coupled',
    description: 'Pull the signals a morning brief needs from different surfaces and confirm they compose into one view. (The jobs leg left with the career-hunter carve, the inbox leg with the email-summarizer carve, and the portfolio leg with the trading carve, ADR-085 Wave 3 — content signals stays the kernel-resident inbox-fed leg; the ticket work queue is the second kernel-resident leg.)',
    steps: [
      { id: 'signals', app: 'content', label: '1) inbox-fed content signals', run: (c) => step(c, 'content', 'signals', 'GET', '/api/content/signals', undefined,
        (j) => Array.isArray(j?.signals) ? { state: 'pass', detail: `${j.signals.length} signal(s)`, output: { count: j.signals.length } } : { state: 'degraded', detail: 'reachable; connect Google to scan email.', output: { count: 0 } }) },
      // (positions step removed: the trading surface carved to the app store, ADR-085 Wave 3.)
      { id: 'queue', app: 'tickets', label: '2) open ticket queue', run: (c) => step(c, 'tickets', 'queue', 'GET', '/api/tickets', undefined,
        (j) => { const n = Array.isArray(j?.tickets) ? j.tickets.length : Array.isArray(j) ? j.length : null; return n == null ? { state: 'degraded', detail: 'ticket queue unavailable.', output: { count: 0 } } : { state: 'pass', detail: `${n} ticket(s)`, output: { count: n } }; }) },
      { id: 'compose', app: 'test-lab', label: '3) can we assemble a brief?', run: async (_c, prior) => {
        const parts = [
          `${prior.signals?.count ?? 0} signal(s)`,
          `${prior.queue?.count ?? 0} ticket(s)`,
        ];
        return { app: 'test-lab', label: 'assemble brief', state: 'pass', detail: `brief composes from ${parts.length} surfaces → ${parts.join(' · ')}` };
      } },
    ] },

  // (coupled scenario 4 "travel → deck → save" removed: its deck step targeted the AI Office
  //  package route and its save step the storage package — both carved to the app store,
  //  ADR-085 Wave 2; travel keeps its own smoke above.)
];

const WORST: State[] = ['fail', 'gap', 'degraded', 'pass'];
/** Roll a set of step states up to the scenario state (worst wins). */
export function rollup(states: State[]): State { for (const s of WORST) if (states.includes(s)) return s; return 'pass'; }
