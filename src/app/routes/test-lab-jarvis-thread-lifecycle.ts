/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove issuer-less Jarvis refusal on the installed, signed-in route with exact synthetic-row cleanup.
 */
import { randomUUID } from 'node:crypto';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import type { ScenarioRunContext, StepResult } from './test-lab-scenarios';

const APP = 'jarvis';
const LABEL = 'Refused thread rolls to an owned fresh thread and cleans up';
const QUESTION = 'the weather today where I live.';
const CLARIFICATION = 'What city or ZIP code should I use for the live weather check?';

type TaskRow = { owner_sub: string | null; metadata: Record<string, unknown> | null };
type TicketRow = { ticket_id: string };

/** The only HTTP calls in this probe: loopback, exact Jarvis routes, initiating session cookie. */
async function call(base: string, cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000), redirect: 'manual',
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, json };
}

async function taskRow(runtime: ScenarioRunContext, taskId: string): Promise<TaskRow | null> {
  const result = await runtime.ctx.pool.query<TaskRow>(
    'SELECT owner_sub, metadata FROM chat_tasks WHERE task_id = $1', [taskId],
  );
  return result.rows[0] ?? null;
}

async function ticketIds(runtime: ScenarioRunContext, taskId: string): Promise<string[]> {
  const result = await runtime.ctx.pool.query<TicketRow>(
    `SELECT ticket_id FROM tickets WHERE owner_sub = $1 AND ticket_type = 'chat'
       AND metadata->>'kind' = 'chat-thread' AND metadata->>'taskId' = $2`,
    [runtime.ownerSub, taskId],
  );
  return result.rows.map(row => row.ticket_id);
}

/**
 * A single bounded Lab step. An absent issuer or cookie writes nothing. IDs are generated here,
 * never accepted from the caller; cleanup re-reads owner, issuer and fixture marker before delete.
 * The fresh ask uses a deterministic location clarification, so no provider handoff is scheduled.
 */
export async function runJarvisLegacyThreadLifecycle(
  cookie: string, runtime?: ScenarioRunContext,
): Promise<StepResult> {
  if (!cookie || !runtime?.issuer || !runtime.ownerSub || !runtime.ctx?.pool) {
    return { app: APP, label: LABEL, state: 'degraded',
      detail: 'A verified issuer, signed-in session cookie and persistent task store are required; no fixture was created.' };
  }

  const id = randomUUID();
  const legacy = `testlab-jarvis-legacy-${id}`;
  const fresh = `testlab-jarvis-fresh-${id}`;
  const marker = `test-lab-refused-thread:${id}`;
  const cleanupErrors: string[] = [];
  let result: StepResult = { app: APP, label: LABEL, state: 'fail', detail: 'Probe did not finish.' };
  let freshAttempted = false;
  let freshSettled = false;
  let legacyCreated = false;
  let jobId: string | null = null;

  try {
    if (await taskRow(runtime, legacy) || await taskRow(runtime, fresh)) throw new Error('Generated task ID is already occupied.');
    const created = await runtime.ctx.taskStore.create({
      taskId: legacy, title: 'Test Lab issuer-less Jarvis thread', processingMode: 'agentic',
      agentId: JARVIS_AGENT_ID, ownerSub: runtime.ownerSub,
      metadata: { origin: 'jarvis-chat', testLabFixture: marker },
    });
    legacyCreated = true;
    if (created.ownerSub !== runtime.ownerSub || created.metadata?.testLabFixture !== marker) {
      throw new Error('The task store did not create the exact owner-bound fixture.');
    }
    const persistedLegacy = await taskRow(runtime, legacy);
    if (!persistedLegacy || persistedLegacy.owner_sub !== runtime.ownerSub
      || persistedLegacy.metadata?.testLabFixture !== marker
      || readOwnerPrincipalIssuer(persistedLegacy.metadata) !== null) {
      throw new Error('The issuer-less fixture was not durably stored as expected.');
    }

    const refused = await call(runtime.apiBaseUrl, cookie, 'POST', '/api/jarvis/ask', { message: QUESTION, sessionId: legacy });
    if (refused.status !== 404 || refused.json.error !== 'session_not_found') {
      throw new Error(`The issuer-less thread was not refused: HTTP ${refused.status}, error=${String(refused.json.error ?? 'none')}.`);
    }

    freshAttempted = true;
    const started = await call(runtime.apiBaseUrl, cookie, 'POST', '/api/jarvis/ask', { message: QUESTION, sessionId: fresh });
    if (started.status !== 202 || started.json.sessionId !== fresh || typeof started.json.jobId !== 'string') {
      freshSettled = started.status !== 202;
      throw new Error(`The fresh thread was not accepted: HTTP ${started.status}, error=${String(started.json.error ?? 'none')}.`);
    }
    jobId = started.json.jobId;
    const deadline = Date.now() + 20_000;
    let completion: { status: number; json: Record<string, unknown> } | null = null;
    while (Date.now() < deadline) {
      completion = await call(runtime.apiBaseUrl, cookie, 'GET', `/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`);
      if (completion.status !== 200 || completion.json.status !== 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    freshSettled = completion?.json.status === 'done' || completion?.json.status === 'error';
    if (completion?.status !== 200 || completion.json.status !== 'done'
      || completion.json.taskId !== fresh || completion.json.answer !== CLARIFICATION
      || !Array.isArray(completion.json.dispatched) || completion.json.dispatched.length !== 0
      || !Array.isArray(completion.json.handoffs) || completion.json.handoffs.length !== 0) {
      throw new Error(`Fresh deterministic answer was not proven: HTTP ${completion?.status ?? 'none'}, status=${String(completion?.json.status ?? 'none')}.`);
    }
    const persistedFresh = await taskRow(runtime, fresh);
    if (!persistedFresh || persistedFresh.owner_sub !== runtime.ownerSub
      || readOwnerPrincipalIssuer(persistedFresh.metadata) !== runtime.issuer
      || persistedFresh.metadata?.origin !== 'jarvis-chat') {
      throw new Error('Fresh thread did not persist with the initiating owner and issuer.');
    }
    result = { app: APP, label: LABEL, state: 'pass', status: 202,
      detail: 'Legacy thread refused 404; fresh thread accepted 202 and answered deterministically with the caller issuer. Cleanup verified below.' };
  } catch (error) {
    result = { app: APP, label: LABEL, state: 'fail',
      detail: error instanceof Error ? error.message : String(error) };
  } finally {
    // A timed-out in-flight fresh ask may still be writing; retain its exact ID for a later
    // bounded cleanup instead of racing the worker. The legacy fixture can always be removed.
    if (freshAttempted && !freshSettled) {
      cleanupErrors.push(`Fresh ask may still be running; exact synthetic task ${fresh} needs a later cleanup check.`);
    } else if (freshAttempted) {
      try {
        const row = await taskRow(runtime, fresh);
        if (row) {
          if (row.owner_sub !== runtime.ownerSub || readOwnerPrincipalIssuer(row.metadata) !== runtime.issuer
            || row.metadata?.origin !== 'jarvis-chat') throw new Error('fresh task ownership changed; refusing deletion');
          const closed = await call(runtime.apiBaseUrl, cookie, 'POST', '/api/jarvis/thread/close', { sessionId: fresh });
          if (closed.status !== 200 || closed.json.ok !== true) cleanupErrors.push(`Synthetic thread close returned HTTP ${closed.status}.`);
          for (const ticketId of await ticketIds(runtime, fresh)) {
            const ticket = await runtime.ctx.ticketService.getTicket(ticketId);
            if (!ticket || ticket.ownerSub !== runtime.ownerSub || ticket.ticketType !== 'chat'
              || ticket.workspaceId || ticket.metadata?.taskId !== fresh) {
              throw new Error(`synthetic chat ticket ${ticketId} did not revalidate`);
            }
            await runtime.ctx.ticketService.deleteTicket(ticketId);
          }
          await runtime.ctx.messageStore.deleteByTask(fresh);
          await runtime.ctx.taskStore.delete(fresh);
        }
      } catch (error) { cleanupErrors.push(`Fresh cleanup: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const row = await taskRow(runtime, legacy);
      if (row) {
        if (row.owner_sub !== runtime.ownerSub || row.metadata?.testLabFixture !== marker
          || readOwnerPrincipalIssuer(row.metadata) !== null) throw new Error('legacy fixture ownership changed; refusing deletion');
        await runtime.ctx.messageStore.deleteByTask(legacy);
        await runtime.ctx.taskStore.delete(legacy);
      } else if (legacyCreated) {
        const transient = await runtime.ctx.taskStore.get(legacy);
        if (transient) {
          if (transient.ownerSub !== runtime.ownerSub || transient.metadata?.testLabFixture !== marker) {
            throw new Error('transient legacy fixture ownership changed; refusing deletion');
          }
          await runtime.ctx.taskStore.delete(legacy);
        }
      }
    } catch (error) { cleanupErrors.push(`Legacy cleanup: ${error instanceof Error ? error.message : String(error)}`); }
    if (jobId && freshSettled) {
      try { await call(runtime.apiBaseUrl, cookie, 'POST', '/api/jarvis/ask/dismiss', { jobId }); }
      catch (error) { cleanupErrors.push(`Job dismissal: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const oldRow = await taskRow(runtime, legacy);
      const newRow = await taskRow(runtime, fresh);
      if (oldRow || (freshSettled && newRow)) cleanupErrors.push(`Synthetic task remains: ${[oldRow ? legacy : '', freshSettled && newRow ? fresh : ''].filter(Boolean).join(', ')}.`);
      if (freshSettled && (await ticketIds(runtime, fresh)).length) cleanupErrors.push(`Synthetic chat ticket remains for ${fresh}.`);
    } catch (error) { cleanupErrors.push(`Cleanup verification: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (cleanupErrors.length) return { ...result, state: 'fail', detail: `${result.detail} ${cleanupErrors.join(' ')}` };
  return { ...result, detail: `${result.detail} Both synthetic tasks, messages and ticket removed.` };
}
