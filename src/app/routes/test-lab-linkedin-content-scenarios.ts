/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the LinkedIn Content Assistant queue workflow. Three read-only steps over the caller's own /api/linkedin-assistant routes: publish without explicit confirmation is refused 428 (probed on draft id 0, which a SERIAL key never issues, so even a regressed gate cannot post), the caller's queue drafts carry their source ticket, citations and - once published - the audited params hash, and an unknown draft id answers 404 exactly like another owner's. Nothing is drafted, approved or published by a run. The ticket-to-publish proof (real Postgres, dispatcher, broker, executor, local provider double) is attached as a regression suite, not re-run live.
 *
 * @module routes/test-lab-linkedin-content-scenarios
 */

import { createChildLogger } from '@/shared/logger';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-linkedin-content-scenarios' });
const APP = 'linkedin-assistant';
/** A draft id no SERIAL sequence issues; a regressed confirm gate still finds nothing to post. */
const NEVER_ISSUED_DRAFT_ID = 0;
/** The largest int4 id: a draft id the caller does not own answers exactly like this one. */
const UNKNOWN_DRAFT_ID = 2147483647;

type Result = (label: string, state: StepResult['state'], detail: string, status?: number, output?: unknown) => StepResult;
const result: Result = (label, state, detail, status, output) => ({
  app: APP, label, state, detail, ...(status ? { status } : {}), ...(output !== undefined ? { output } : {}),
});

/** One draft as the list route returns it; only the provenance fields the steps read. */
interface ListedDraft {
  state?: string;
  sourceTicketId?: string | null;
  sourceCitations?: unknown;
  publishParamsHash?: string | null;
}

/** A loopback call to the caller's own assistant routes, forwarding their session cookie. */
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/linkedin-assistant${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!String(response.headers.get('content-type') || '').includes('application/json')) return { status: response.status, json: null };
  try {
    return { status: response.status, json: await response.json() };
  } catch (error) {
    logger.error({ err: error, method, path, status: response.status }, 'Test Lab LinkedIn assistant call answered malformed JSON');
    return { status: response.status, json: null };
  }
}

/**
 * @description Refusal step: a publish without `confirm: true` must answer 428 before any draft is
 * looked up. Probed on a draft id that never exists, so a regressed gate answers 404 and posts nothing.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result.
 */
async function confirmGateStep(cookie: string): Promise<StepResult> {
  const label = 'Publish needs explicit confirmation';
  const res = await call(cookie, 'POST', `/drafts/${NEVER_ISSUED_DRAFT_ID}/publish`, {});
  if (res.status === 401) return result(label, 'degraded', 'Sign in to exercise your own LinkedIn assistant.', 401);
  if (res.status === 428) return result(label, 'pass', 'An unconfirmed publish was refused before any draft or connection was touched.', 428);
  return result(label, 'fail', `Expected 428 for a publish without confirmation, got HTTP ${res.status} (the confirm gate regressed).`, res.status);
}

/**
 * @description Provenance step: the caller's queue-created drafts name their source ticket and carry a
 * citation list; published ones also carry the params hash that joins their connector audit rows.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; degraded when the caller has no queue draft yet.
 */
async function queueProvenanceStep(cookie: string): Promise<StepResult> {
  const label = 'Your queue drafts keep their ticket';
  const res = await call(cookie, 'GET', '/drafts');
  if (res.status === 401) return result(label, 'degraded', 'Sign in to list your own drafts.', 401);
  if (res.status !== 200 || !Array.isArray(res.json?.drafts)) return result(label, 'fail', `Drafts returned HTTP ${res.status} without a list.`, res.status);
  const queued = (res.json.drafts as ListedDraft[]).filter((d) => d.sourceTicketId);
  if (queued.length === 0) {
    return result(label, 'degraded', 'No queue-created draft yet. File one with POST /api/social/linkedin-content-queue (Social 1.5.1 or later).', 200);
  }
  const missing = queued.filter((d) => !Array.isArray(d.sourceCitations));
  if (missing.length) return result(label, 'fail', `${missing.length} queue draft(s) came back without a citation list.`, 200);
  const published = queued.filter((d) => d.state === 'published');
  const joinable = published.filter((d) => d.publishParamsHash).length;
  return result(label, 'pass', `${queued.length} queue draft(s) name their ticket; ${joinable} of ${published.length} published carry the audited params hash.`, 200);
}

/**
 * @description Ownership step: an unknown draft id answers 404, which is what another owner's id
 * answers too, so draft ids are not an oracle.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result.
 */
async function unknownDraftStep(cookie: string): Promise<StepResult> {
  const label = 'Unknown draft hidden';
  const res = await call(cookie, 'GET', `/drafts/${UNKNOWN_DRAFT_ID}`);
  if (res.status === 401) return result(label, 'degraded', 'Sign in to check the ownership boundary.', 401);
  if (res.status === 404) return result(label, 'pass', 'A draft id you do not own answers 404.', 404);
  return result(label, 'fail', `Expected 404 for a draft you do not own, got HTTP ${res.status}.`, res.status);
}

/** The LinkedIn content queue Test Lab card. */
export const LINKEDIN_CONTENT_SCENARIOS: Scenario[] = [{
  id: 'linkedin-content-queue', title: 'LinkedIn content queue — ticket to confirmed publish', group: 'tool',
  description: 'Checks the publish boundary of queue-created LinkedIn posts on your account: publishing needs explicit confirmation, your queue drafts keep the ticket and citations they came from (and, once published, the params hash that joins their connector audit rows), and a draft you do not own is hidden. Nothing is drafted, approved or published by a run. The full ticket -> dispatch -> draft -> approve -> confirmed publish proof runs in the attached real-Postgres suite against a local provider double, never LinkedIn.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/linkedin-content-queue-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/linkedin-content-queue-workflow.spec.ts' },
    { level: 'unit', path: 'tests/unit/linkedin-assistant.spec.ts' },
    { level: 'unit', path: 'tests/unit/connectors/connector-write-actions.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-linkedin-content-registration.spec.ts' },
  ],
  steps: [
    { id: 'confirm-gate', app: APP, label: 'Publish needs explicit confirmation', run: confirmGateStep },
    { id: 'queue-provenance', app: APP, label: 'Your queue drafts keep their ticket', run: queueProvenanceStep },
    { id: 'unknown-draft', app: APP, label: 'Unknown draft hidden', run: unknownDraftStep },
  ],
}];
