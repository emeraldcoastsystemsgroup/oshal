/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register connector callback refusal and browser-bound OAuth regression suites with the existing Test Lab.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description Exercise only refusal paths, anonymously and without any provider request. */
async function refusal(path: string, expected: number, label: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  return {
    app: 'connectors', label, status: response.status,
    state: response.status === expected ? 'pass' : response.status === 404 ? 'gap' : 'fail',
    detail: `HTTP ${response.status}; expected ${expected}. No provider authorization or token exchange was requested.`,
  };
}

export const CONNECTOR_OAUTH_SCENARIOS: Scenario[] = [{
  id: 'connector-oauth-boundary', title: 'Connector sign-in callback boundary', group: 'tool',
  description: 'Check that an anonymous callback reaches state validation while connector data and completion still require sign-in. Cross-domain success and replay cases use the isolated provider fixtures in the linked suites.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/connector-oauth-callback.spec.ts' },
    { level: 'integration', path: 'tests/unit/connector-reconnect.spec.ts' },
  ],
  steps: [
    { id: 'invalid-state', app: 'connectors', label: 'Reject invalid callback', run: () => refusal('/api/connect/google/callback?state=test-lab-invalid&code=test-lab-unused', 400, 'Invalid state refused') },
    { id: 'private-token', app: 'connectors', label: 'Protect connector credentials', run: () => refusal('/api/connect/google/access-token', 401, 'Credentials require sign-in') },
    { id: 'private-completion', app: 'connectors', label: 'Protect completion', run: () => refusal('/api/connect/google/complete?ticket=test-lab-unused', 401, 'Completion requires sign-in') },
  ],
}];
