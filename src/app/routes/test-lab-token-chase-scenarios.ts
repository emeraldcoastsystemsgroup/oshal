/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Registered the Token Chase checkpoint + tail replay card (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046): one read-only step listing the captured runs visible to the caller through the owner-scoped read route, with the workspace-bound checkpoint, owner-store, hermetic tail, bot-route and end-to-end suites attached as regressionTests. No replay is fired from the Lab on purpose: a tail replay restores a worktree on a bot node and is an action, not a probe.
 */
import type { Scenario, StepResult } from './test-lab-scenarios';

/** @description The read-only route the step probes; owner-scoped, never fires a replay. */
const RUNS_PATH = '/api/token-chase/runs';

/**
 * @description Lists the caller's captured Token Chase runs. Degraded when the caller is not signed in
 * or nothing has been captured yet (capture is a bot-node flag plus one agentic run), gap when the
 * route is missing, fail on a server error or an unexpected shape. Reads only.
 * @param cookie - The caller's session cookie.
 * @param baseUrl - The api origin (this process by default).
 * @returns The step result.
 */
export async function capturedRunsStep(cookie: string, baseUrl = `http://127.0.0.1:${process.env.PORT || '5000'}`): Promise<StepResult> {
  const app = 'token-chase';
  const label = 'Captured runs (read-only)';
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${RUNS_PATH}`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000), redirect: 'manual' });
  } catch (err) {
    return { app, label, state: 'fail', detail: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.status !== 200) {
    const state: StepResult['state'] = [401, 403, 503].includes(response.status) ? 'degraded' : response.status === 404 ? 'gap' : 'fail';
    return { app, label, status: response.status, state, detail: `${RUNS_PATH} returned HTTP ${response.status}; a signed-in caller is required. No replay was attempted.` };
  }
  const data = await response.json() as { runs?: unknown };
  const runs = Array.isArray(data.runs) ? (data.runs as Array<Record<string, unknown>>) : null;
  const wellFormed = runs !== null && runs.every((run) => run && typeof run === 'object' && typeof run.runId === 'string' && Number.isInteger(run.frameCount));
  if (!wellFormed) return { app, label, status: 200, state: 'fail', detail: 'The runs list did not carry runId + frameCount rows.' };
  if (runs!.length === 0) {
    return {
      app, label, status: 200, state: 'degraded', output: { runs: 0 },
      detail: 'No captured runs are visible to this caller. Capture needs TOKEN_CHASE_CAPTURE=true on a bot node plus one agentic run; the checkpoint and the hermetic tail are proven by the attached suites, not by this step.',
    };
  }
  const newest = runs![0];
  return {
    app, label, status: 200, state: 'pass', output: { runs: runs!.length, newest: newest.runId, frames: newest.frameCount },
    detail: `${runs!.length} captured run(s) visible; newest ${String(newest.runId)} with ${String(newest.frameCount)} frame(s). Read only — no replay fired.`,
  };
}

/** @description The Token Chase card: one read-only step plus the suites that prove the checkpoint and the tail. */
export const TOKEN_CHASE_SCENARIOS: Scenario[] = [{
  id: 'token-chase-checkpoint-replay',
  title: 'Token Chase checkpoint and tail replay',
  group: 'tool',
  description: 'Read the captured Token Chase runs visible to the caller. The attached suites prove the workspace-bound checkpoint (private-git commit, ciphertext-only owner-store version, per-turn replay pins), the hermetic no-edit tail on the bot node and the artifact/store comparison; a tail replay is an action and is not fired here.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/token-chase-turn-provenance.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-workspace-checkpoint.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-owner-store-snapshot.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-capture-contract.spec.ts' },
    { level: 'unit', path: 'tests/unit/token-chase-tail-replay.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-bot-tail-route.spec.ts' },
    { level: 'integration', path: 'tests/unit/token-chase-checkpoint-replay-e2e.spec.ts' },
    { level: 'unit', path: 'tests/unit/token-chase-test-lab.spec.ts' },
  ],
  steps: [{ id: 'captured-runs', app: 'token-chase', label: 'Captured runs (read-only)', run: (cookie) => capturedRunsStep(cookie) }],
}];
