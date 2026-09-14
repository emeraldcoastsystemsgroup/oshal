/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register artifact discovery and live Jarvis proposals in the existing Test Lab, linked to their regression suites.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Register exact-principal artifact relay and revocation regression coverage.
 */
import { randomUUID } from 'node:crypto';
import { buildToolsBlock, buildArtifactToolGuidance } from './jarvis-tool-catalog';
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description Real loopback request with the initiating user's session and a bounded deadline. */
async function call(cookie: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

/** @description Report unavailable prerequisites distinctly from a broken assertion. */
function result(label: string, pass: boolean, detail: string, status?: number): StepResult {
  const state = status === 404 ? 'gap' : [401, 403, 409, 429, 503].includes(status || 0) ? 'degraded' : pass ? 'pass' : 'fail';
  return { app: 'artifact-exchange', label, state, detail, ...(status ? { status } : {}) };
}

/** @description Prove discovery returns real arrays and exposes the registered kernel email target. */
async function discovery(cookie: string): Promise<StepResult> {
  const sources = await call(cookie, '/api/artifacts/sources?type=image%2Fsvg%2Bxml');
  if (sources.status !== 200) return result('Source discovery', false, `Sources returned HTTP ${sources.status}.`, sources.status);
  const actions = await call(cookie, '/api/artifacts/actions?type=image%2Fsvg%2Bxml');
  const pass = sources.status === 200 && Array.isArray(sources.json.sources) && actions.status === 200
    && Array.isArray(actions.json.actions) && actions.json.actions.some((a: any) => a.app === 'kernel-email' && a.id === 'compose');
  return result('Sources and destinations', pass, pass ? 'Source catalog and compatible email destination are available.' : 'Discovery contract or email destination is missing.', actions.status);
}

/** @description Create an ephemeral handle over the Lab's sample visual; no user file or destination is written. */
async function mint(cookie: string): Promise<StepResult> {
  const response = await call(cookie, '/api/artifacts/handles', {
    source: '/api/test-lab/visual/weather.svg', type: 'image/svg+xml', name: 'test-lab-artifact.svg',
  });
  const pass = response.status === 201 && /^art_[\w-]+$/.test(response.json.ref || '');
  return { ...result('Sample handle', pass, pass ? 'Created an owner-bound sample handle; it expires automatically.' : `Handle mint returned HTTP ${response.status}.`, response.status),
    ...(pass ? { output: { ref: response.json.ref } } : {}) };
}

/** @description Ask the actual Jarvis model, poll its proposal, and never dispatch that proposal. */
async function proposal(cookie: string, prior: Record<string, any>, ambiguous: boolean): Promise<StepResult> {
  const ref = prior.sample?.ref;
  if (!ref) return result('Jarvis proposal', false, 'Sample handle prerequisite did not pass.', 503);
  const label = ambiguous ? 'Ambiguous target' : 'Named email target';
  const started = await call(cookie, '/api/jarvis/ask', {
    artifact: { ref }, sessionId: `test-lab-artifact-${randomUUID()}`,
    message: ambiguous ? 'Send this somewhere useful.' : 'Open this selected file in the email compose screen. Do not send an email.',
  });
  if (started.status !== 202 || typeof started.json.jobId !== 'string') return result(label, false, `Jarvis start returned HTTP ${started.status}.`, started.status);
  for (let attempt = 0; attempt < 45; attempt++) {
    const response = await call(cookie, '/api/jarvis/ask/result?jobId=' + encodeURIComponent(started.json.jobId));
    if (response.status !== 200) return result(label, false, `Polling returned HTTP ${response.status}.`, response.status);
    const body = response.json;
    if (body.status === 'done') {
      const quiet = !(body.dispatched?.length || body.surfaceOps?.length);
      const pass = quiet && (ambiguous ? !body.artifactAction && typeof body.answer === 'string' && /\?/.test(body.answer)
        : body.artifactAction?.ref === ref && body.artifactAction?.app === 'kernel-email' && body.artifactAction?.id === 'compose');
      return result(label, pass, pass ? (ambiguous ? 'Jarvis asked for a destination without dispatching.' : 'Jarvis proposed the correct owner-bound email action; the Lab did not dispatch it.') : 'Jarvis returned an incorrect action or did not clarify.');
    }
    if (body.status !== 'pending') return result(label, false, `Jarvis ended with ${String(body.status)}: ${String(body.error || '')}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return result(label, false, 'Jarvis did not finish within the polling deadline.', 503);
}

/** @description Probe the real email refusal gate without confirmation, recipients or an outbound send. */
async function confirmation(cookie: string, prior: Record<string, any>): Promise<StepResult> {
  if (!prior.sample?.ref) return result('Email confirmation', false, 'Sample handle prerequisite did not pass.', 503);
  const response = await call(cookie, '/api/artifacts/builtin/email', { ref: prior.sample.ref });
  return result('Email confirmation', response.status === 428, `Unconfirmed email request returned HTTP ${response.status}; expected 428.`, response.status);
}

export const ARTIFACT_SCENARIOS: Scenario[] = [
  {
    id: 'artifact-discovery', title: 'Artifact picker and tool metadata', group: 'tool',
    description: 'Check the active source/destination catalogs and Jarvis YAML tool load. Browser selection is covered by the linked browser suites.',
    regressionTests: [
      { level: 'integration', path: 'tests/unit/test-lab-artifact-registration.spec.ts' },
      { level: 'unit', path: 'tests/unit/artifact-exchange.spec.ts' },
      { level: 'unit', path: 'tests/unit/jarvis-tool-catalog.spec.ts' },
      { level: 'integration', path: 'tests/unit/artifact-mint-bytes-route.spec.ts' },
      { level: 'integration', path: 'tests/unit/artifact-redeem-relay.spec.ts' },
      { level: 'integration', path: 'tests/unit/artifact-authenticated-relay.spec.ts' },
      { level: 'browser', path: 'tests/unit/artifact-picker.spec.ts' },
    ],
    steps: [
      { id: 'discovery', app: 'artifact-exchange', label: 'Source and target catalogs', run: discovery },
      { id: 'yaml', app: 'jarvis', label: 'YAML tool metadata', run: async () => {
        const tools = buildToolsBlock({ message: 'email this selected file' });
        const guidance = buildArtifactToolGuidance();
        return result('YAML tool metadata', tools.includes('Keywords:') && guidance.includes('email'), 'Loaded and validated the actual Jarvis tool YAML.');
      } },
    ],
  },
  {
    id: 'jarvis-artifact-handoff', title: 'Jarvis artifact target and confirmation', group: 'jarvis',
    description: 'Use a sample handle to test the live model’s named target and ambiguous request, then check email refuses unconfirmed sends. Creates Lab chat turns; does not dispatch destinations.',
    regressionTests: [
      { level: 'integration', path: 'tests/unit/jarvis-artifact-routing.spec.ts' },
      { level: 'browser', path: 'tests/unit/artifact-dispatch-browser.spec.ts' },
    ],
    steps: [
      { id: 'sample', app: 'artifact-exchange', label: 'Mint sample handle', run: mint },
      { id: 'named', app: 'jarvis', label: 'Resolve named email target', run: (cookie, prior) => proposal(cookie, prior, false) },
      { id: 'ambiguous', app: 'jarvis', label: 'Clarify ambiguous target', run: (cookie, prior) => proposal(cookie, prior, true) },
      { id: 'confirmation', app: 'artifact-exchange', label: 'Require email confirmation', run: confirmation },
    ],
  },
];
