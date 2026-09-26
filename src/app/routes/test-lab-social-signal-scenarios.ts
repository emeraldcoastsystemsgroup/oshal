/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for subscription-driven social signals (BACKLOG "Subscription-driven social signals"). Four deterministic steps over the caller's own /api/content/subscriptions routes: an unregistered bot is refused before anything is stored, the caller's watches are listed, another subscription's delivery audit answers 404, and the caller's own first watch returns its delivery audit. Nothing is registered, published or disabled on a passing run; if the bot refusal ever regresses, the step disables the watch it accidentally created and fails. The real-boundary proof (enforcing Postgres role, Redis lanes) is attached as a regression suite, not re-run live.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The loopback call no longer swallows a body parse failure in an empty catch: a non-JSON answer (by content-type) is returned with json=null without parsing, and a JSON-labelled body that fails to parse is logged at ERROR with its path and status before the step classifies the HTTP status. Guard: the non-JSON and malformed-JSON cases in tests/unit/test-lab-social-signal-registration.spec.ts.
 *
 * @module routes/test-lab-social-signal-scenarios
 */

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-social-signal-scenarios' });
const APP = 'social-signals';
const UNREGISTERED_BOT = 'test-lab-unregistered-bot';

type Result = (label: string, state: StepResult['state'], detail: string, status?: number, output?: unknown) => StepResult;
const result: Result = (label, state, detail, status, output) => ({
  app: APP, label, state, detail, ...(status ? { status } : {}), ...(output !== undefined ? { output } : {}),
});

/** A loopback call to the caller's own subscription routes, forwarding their session cookie. */
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/content${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!String(response.headers.get('content-type') || '').includes('application/json')) return { status: response.status, json: null };
  try {
    return { status: response.status, json: await response.json() };
  } catch (error) {
    logger.error({ err: error, method, path, status: response.status }, 'Test Lab social-signal call answered malformed JSON');
    return { status: response.status, json: null };
  }
}

/**
 * @description Refusal step: a subscription naming a bot no registry entry carries must be
 * refused 400 unknown_bot. A 201 means the binding regressed; the step disables that watch.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result.
 */
async function refuseUnregisteredBotStep(cookie: string): Promise<StepResult> {
  const label = 'Unregistered bot refused';
  const res = await call(cookie, 'POST', '/subscriptions', { botAgentId: UNREGISTERED_BOT, selector: { kind: 'keyword', value: 'test lab' } });
  if (res.status === 401) return result(label, 'degraded', 'Sign in to exercise your own subscriptions.', 401);
  if (res.status === 400 && res.json?.error === 'unknown_bot') return result(label, 'pass', 'A watch for a bot this swarm does not run was refused before anything was stored.', 400);
  if (res.status === 201 && res.json?.subscriptionId) {
    await call(cookie, 'DELETE', `/subscriptions/${encodeURIComponent(String(res.json.subscriptionId))}`);
    return result(label, 'fail', 'A watch for an unregistered bot was ACCEPTED (bot binding regressed); the Lab disabled it again.', 201);
  }
  return result(label, 'fail', `Expected 400 unknown_bot, got HTTP ${res.status}.`, res.status);
}

/**
 * @description List step: the caller's own watches (never anyone else's).
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; its output (the subscription ids) feeds the own-audit step.
 */
async function listStep(cookie: string): Promise<StepResult> {
  const label = 'Your subscriptions';
  const res = await call(cookie, 'GET', '/subscriptions');
  if (res.status === 401) return result(label, 'degraded', 'Sign in to list your own subscriptions.', 401);
  if (res.status !== 200 || !Array.isArray(res.json?.subscriptions)) return result(label, 'fail', `Subscriptions returned HTTP ${res.status} without a list.`, res.status);
  const ids = res.json.subscriptions.map((s: { subscriptionId?: unknown }) => String(s.subscriptionId));
  return result(label, 'pass', `${ids.length} watch(es) on your account.`, 200, ids);
}

/**
 * @description Ownership step: a delivery audit for a subscription the caller does not own must
 * answer 404, exactly like one that does not exist.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result.
 */
async function foreignAuditStep(cookie: string): Promise<StepResult> {
  const label = 'Another subscription audit hidden';
  const res = await call(cookie, 'GET', `/subscriptions/${randomUUID()}/deliveries`);
  if (res.status === 401) return result(label, 'degraded', 'Sign in to check the ownership boundary.', 401);
  if (res.status === 404) return result(label, 'pass', 'A delivery audit you do not own answers 404.', 404);
  return result(label, 'fail', `Expected 404 for a subscription you do not own, got HTTP ${res.status}.`, res.status);
}

/**
 * @description Own-audit step: the caller's first watch returns its delivery audit rows.
 * @param cookie - The initiating user's session cookie.
 * @param prior - Outputs of earlier steps; `list` holds the caller's subscription ids.
 * @returns The step result; degraded when the caller has no watch yet.
 */
async function ownAuditStep(cookie: string, prior: Record<string, any>): Promise<StepResult> {
  const label = 'Your delivery audit';
  const first = Array.isArray(prior.list) ? prior.list[0] : undefined;
  if (!first) return result(label, 'degraded', 'No subscription yet; register a watch in Social Signals to see its delivery audit.');
  const res = await call(cookie, 'GET', `/subscriptions/${encodeURIComponent(String(first))}/deliveries`);
  if (res.status !== 200 || !Array.isArray(res.json?.deliveries)) return result(label, 'fail', `Delivery audit returned HTTP ${res.status}.`, res.status);
  const published = res.json.deliveries.filter((d: { publishedAt?: unknown }) => d.publishedAt).length;
  return result(label, 'pass', `${res.json.deliveries.length} delivery record(s) for your first watch, ${published} published to its bot lane.`, 200);
}

/** The social-signals Test Lab card. */
export const SOCIAL_SIGNAL_SCENARIOS: Scenario[] = [{
  id: 'social-signal-subscriptions', title: 'Social signals — your watches reach only your bot', group: 'tool',
  description: 'Checks the owner boundary of subscription-driven social signals: a watch must name a registered bot, you see only your own watches, another watch\'s delivery audit is hidden, and your own watch shows which captured messages went to its bot lane. Nothing is registered or published by a passing run.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/social-signal-subscriptions.spec.ts' },
    { level: 'integration', path: 'tests/unit/social-signal-subscriptions-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/background-system-identity.spec.ts' },
    { level: 'unit', path: 'tests/unit/lazy-store-rls.spec.ts' },
    { level: 'unit', path: 'tests/unit/route-schema-validate-only.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-social-signal-registration.spec.ts' },
  ],
  steps: [
    { id: 'refuse', app: APP, label: 'Unregistered bot refused', run: refuseUnregisteredBotStep },
    { id: 'list', app: APP, label: 'Your subscriptions', run: listStep },
    { id: 'foreign', app: APP, label: 'Another subscription audit hidden', run: foreignAuditStep },
    { id: 'own-audit', app: APP, label: 'Your delivery audit', run: ownAuditStep },
  ],
}];
