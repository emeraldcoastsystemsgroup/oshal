/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Register the vendor-login seeding rail with the Test Lab. The runnable half is deliberately refusal-only: an anonymous caller must not reach the import, the sign-out, or the status probe on any of the three vendor auth mounts. Nothing here pushes a credential, signs anyone in, or contacts a vendor endpoint — the success path needs the operator's own browser login, which the Lab must never attempt. regressionTests carry the guards that ship with the rail so a test file on disk is not mistaken for Lab registration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The description now says what the Google half actually is - DORMANT, because Google retired Code Assist sign-in for individuals on 2026-09-22 and the file the push rail adopts can no longer be produced - and the executability guards join regressionTests. A seeding rail that ends in a brain option nobody can run is not a seeded rail, so the spec proving the option is refused belongs to this scenario as much as the one proving the import is gated. The refusal steps are unchanged: a closed door stays worth checking whether or not anyone is coming through it.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/**
 * @description Call one vendor auth route anonymously and report whether it refused. Both a 401
 * and a redirect to the identity provider count as refused — which of the two arrives depends on
 * the deployment's session middleware, and neither serves the route.
 * @param method - HTTP method the production route registers
 * @param path - Route path under the vendor's auth mount
 * @param label - What the Lab shows for this step
 * @returns The step result
 */
async function anonymousRefusal(method: 'GET' | 'POST', path: string, label: string): Promise<StepResult> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  });
  const refused = response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400);
  return {
    app: 'config-admin',
    label,
    status: response.status,
    state: refused ? 'pass' : response.status === 404 ? 'gap' : 'fail',
    detail: `HTTP ${response.status}; a 401/403 or a sign-in redirect is the pass. `
      + 'No credential was sent and no vendor endpoint was contacted.',
  };
}

export const VENDOR_LOGIN_SCENARIOS: Scenario[] = [{
  id: 'vendor-login-seeding', title: 'Vendor login seeding rail — who may push a CLI login into the swarm', group: 'tool',
  description:
    'The operator signs into Codex and Claude in his own browser, on his own machine, and the oshal client pushes each vendor CLI\'s login file to its import route. The Google row is DORMANT: Google retired Gemini Code Assist sign-in for individuals on 2026-09-22, so the file that rail adopts can no longer be produced by a sign-in, while the route and its gates are kept and still checked here. This scenario exercises only the closed door: an anonymous caller reaching import, sign-out or the connect-state probe on any of the three mounts. The open door needs a real browser login and is not something the Lab may perform.',
  regressionTests: [
    // The Google half, added 2026-09-22: the route, the ADR-127 gates and the filesystem write.
    { level: 'integration', path: 'tests/unit/gemini-demo-login-adoption.spec.ts' },
    // Where a Gemini turn RUNS once a login has been pushed - and, since 2026-09-22, that it
    // does NOT resolve to a harness no bot node can execute.
    { level: 'unit', path: 'tests/unit/gemini-pushed-login-brain.spec.ts' },
    // Seeding a credential is only half a rail: the brain option it feeds must be offered on
    // exactly the conditions a turn can run on, refused on PUT otherwise, and an unresolvable
    // dispatch must degrade to a hosted lane rather than reach the user.
    { level: 'integration', path: 'tests/unit/cli-brain-executability.spec.ts' },
    // Whether this node could run the Antigravity CLI at all - binary presence and the libc.
    { level: 'unit', path: 'tests/unit/antigravity-cli-availability.spec.ts' },
    // The Claude Code half of the same rail.
    { level: 'integration', path: 'tests/unit/claude-code-demo-login-adoption.spec.ts' },
    { level: 'integration', path: 'tests/unit/claude-code-credential-distribution-boundary.spec.ts' },
    // The ADR-127 carve itself: the negative space every vendor's CLI shares.
    { level: 'unit', path: 'tests/unit/demo-cli-brain-carve.spec.ts' },
    { level: 'unit', path: 'tests/unit/cli-tool-boundary-demo-carve.spec.ts' },
    // The satellite half — what may leave the operator's machine, and where it is sent.
    { level: 'unit', path: 'tests/unit/node-login-push.spec.ts' },
    { level: 'unit', path: 'tests/unit/node-login-launch.spec.ts' },
  ],
  steps: [
    { id: 'gemini-import', app: 'config-admin', label: 'Google import refuses an anonymous caller', run: () => anonymousRefusal('POST', '/api/gemini/auth/import', 'Gemini import requires sign-in') },
    { id: 'gemini-signout', app: 'config-admin', label: 'Google sign-out refuses an anonymous caller', run: () => anonymousRefusal('POST', '/api/gemini/auth/signout', 'Gemini sign-out requires sign-in') },
    { id: 'gemini-status', app: 'config-admin', label: 'Google connect-state refuses an anonymous caller', run: () => anonymousRefusal('GET', '/api/gemini/auth/status', 'Gemini status requires sign-in') },
    { id: 'claude-import', app: 'config-admin', label: 'Claude import refuses an anonymous caller', run: () => anonymousRefusal('POST', '/api/claude-code/auth/import', 'Claude Code import requires sign-in') },
    { id: 'codex-import', app: 'config-admin', label: 'Codex import refuses an anonymous caller', run: () => anonymousRefusal('POST', '/api/openai-codex/oauth/import', 'Codex import requires sign-in') },
  ],
}];
