/**
 * Real-boundary guard for BACKLOG "LinkedIn Content Assistant queue workflow".
 *
 * THE BOUNDARY THAT FAILED: a `linkedin-content-post` ticket never reached a draft. The Social
 * manifest registered its workflow with no `pipeline`, the kernel queue binding admits only
 * `pipeline: manifest-worker`, and the only spec for the binding hand-built a workflow that already
 * carried the pipeline over a pool double - so the mismatch, the unique owner/ticket fence and the
 * publish provenance were never exercised against a real database or a real publish.
 *
 * NOTHING ON THAT BOUNDARY IS DOUBLED HERE: a disposable postgres:16-alpine with the real
 * migrations (083 audit trail, 085 drafts, 112 FORCE-RLS owner policy, 151 audit columns, 169
 * publish provenance); a NOSUPERUSER NOBYPASSRLS runtime role behind the production GUC pool
 * wrapper, owning the draft table the way app-role provisioning leaves it; the real ticket
 * store/service; the real workflow registry and dispatch routing; the real manifest-worker
 * dispatcher and queue binding; the real assistant router (confirm gate included); the real token
 * broker over an oshal_connections row sealed with the real per-user DEK envelope crypto; the real
 * connector write-action executor running the shipped swarm-apps/connectors/linkedin.yaml action.
 *
 * Doubled, OUTSIDE that boundary and named: the social-writer bot node (its `execute` returns a
 * fixture body - model output is not what is under test), the quality-judge brain (a fixture
 * verdict), the owner's hosted-brain lookup, and LinkedIn itself - a local node:http endpoint the
 * shipped connector definition is pointed at by baseUrl only. Nothing here contacts LinkedIn; one
 * real public post is an operator step and is not claimed.
 *
 * SELF-VALIDATED: an INSERT into social_content_drafts that claims another user's sub is refused
 * with SQLSTATE 42501, so the fixture enforces row-level security rather than agreeing with itself.
 *
 * Docker is REQUIRED - a missing engine fails, never skips.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial - one queue ticket through registry, dispatch, binding, owner-scoped draft, approval, the 428 confirm gate and a confirmed publish on the caller's brokered token, with the draft joined to its connector_action_audit rows by params hash and the outcome written back to the ticket; retry idempotency through the real unique index; cross-owner, unauthenticated, unapproved, missing-connection, provider-rejection, forged-ticket and pipeline-less-workflow denials.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { ensureTicketSchema } from '@/shared/services/database';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import type { InternalTicket } from '@/entities/ticket';
import { InMemoryTaskStore } from '@/entities/task/services/in-memory-task-store';
import { InMemoryMessageStore } from '@/entities/message/services/in-memory-message-store';
import type { BotNodeClient } from '@/features/agent-management';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration/services/workflow-pipeline-registry';
import { BUILT_IN_TICKET_TYPES, chooseDispatchPath, type WorkflowDefinition } from '@/features/swarm-orchestration/services/dispatch-routing';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { loadConnectorSpec, type ConnectorSpec } from '@/app/connectors/runtime';
import { ensureConnectionsSchema } from '@/app/routes/connectors-routes';
import { upsertConnection } from '@/app/routes/connector-tenancy';
import { encryptToken } from '@/app/routes/connector-token-crypto';
import { createLinkedInAssistantRoutes } from '@/app/routes/linkedin-assistant-routes';
import { bindLinkedInContentWorker, LINKEDIN_CONTENT_QUEUE_AGENT_ID, LINKEDIN_CONTENT_QUEUE_WORKFLOW } from '@/app/linkedin-content-queue-workflow';
import { LINKEDIN_TICKET_PROVENANCE_KEY } from '@/app/linkedin-content-ticket-provenance';

const ROLE = 'linkedin_queue_runtime';
const OWNER = 'linkedin-queue-owner-sub';
const OTHER = 'linkedin-queue-other-sub';
const UNCONNECTED = 'linkedin-queue-unconnected-sub';
const REJECTED = 'linkedin-queue-rejected-sub';
/** Per-user brokered tokens, minted here so no literal secret is written down. */
const OWNER_TOKEN = `owner-${randomUUID()}`;
const REJECTED_TOKEN = `rejected-${randomUUID()}`;
const CITATIONS = ['https://example.test/release-notes', 'https://example.test/benchmark'];
const DRAFT_BODY = 'We shipped the queue bridge.\n\nEvery queued post now waits for a human.\n\nSources: https://example.test/release-notes';
/** The workflow block Social 1.5.1 declares (store social/oshal-app.yaml). */
const SOCIAL_WORKFLOW: WorkflowDefinition = {
  ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW, name: 'LinkedIn Content Assistant', pipeline: 'manifest-worker', workerBot: 'social-writer',
};

const fixture = new DisposablePostgres({
  purpose: 'linkedin-content-queue',
  migrations: [
    '001-multi-agent-foundation.sql',
    '005-conversation-history-and-usage.sql',
    '083-connector-action-audit.sql',
    '085-social-content-drafts.sql',
    '112-owner-column-rls.sql',
    '151-connector-read-audit-columns.sql',
    '169-social-content-draft-publish-provenance.sql',
  ],
  roles: [ROLE],
});
const registry = WorkflowPipelineRegistry.getInstance();
const taskStore = new InMemoryTaskStore();
const messageStore = new InMemoryMessageStore();
/** Every request the LinkedIn double received, oldest first. */
const providerCalls: Array<{ method: string; path: string; authorization?: string; restli?: string; body: any }> = [];
/** The quality-judge brain: a fixture verdict, so grading is deterministic and costs nothing. */
const judge = { processMessage: async () => ({ success: true, response: JSON.stringify({ score: 84, rationale: 'fixture verdict', dimensions: {} }) }) };

let runtimePool: Pool;
let tickets: TicketService;
let provider: Server;
let api: Server;
let apiBase = '';
let linkedinSpec: ConnectorSpec;
let ownerTicket: InternalTicket;
let ownerDraftId = 0;

/** The LinkedIn double: 201 + a post id for the owner's token, 422 for the rejected token, 401 otherwise. */
function startProvider(): Promise<void> {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      providerCalls.push({ method: String(req.method), path: String(req.url), authorization: req.headers.authorization,
        restli: req.headers['x-restli-protocol-version'] as string | undefined, body: raw ? JSON.parse(raw) : undefined });
      const token = req.headers.authorization;
      const status = token === `Bearer ${OWNER_TOKEN}` ? 201 : token === `Bearer ${REJECTED_TOKEN}` ? 422 : 401;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 201 ? { id: `urn:li:share:${providerCalls.length}` } : { message: 'refused by the fixture provider' }));
    });
  });
  return new Promise((done) => provider.listen(0, '127.0.0.1', () => done()));
}

/** The API under test: the production identity middleware shape plus the real assistant router. */
function startApi(ctx: AppContext): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-fixture-sub') || undefined;
    if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
    runWithRequestIdentity({ sub: sub ?? null, isOperator: false }, () => next());
  });
  app.use('/api/linkedin-assistant', createLinkedInAssistantRoutes(ctx, path.join(process.cwd(), 'src/api'), { spec: linkedinSpec }));
  api = createServer(app);
  return new Promise((done) => api.listen(0, '127.0.0.1', () => done()));
}

/** Seeds one real brokered LinkedIn connection through the production upsert + envelope crypto. */
async function connect(sub: string, token: string, accountId: string): Promise<void> {
  await runWithRequestIdentity({ sub, isOperator: false }, async () => {
    await upsertConnection(runtimePool, {
      userSub: sub, userEmail: '', provider: 'linkedin', accountEmail: null, accountId, scopes: 'w_member_social',
      encAccess: await encryptToken(runtimePool, sub, token), encRefresh: null,
      expiry: new Date(Date.now() + 3_600_000), connectedBySub: sub, label: 'fixture',
    });
  });
}

/** Calls the assistant router as one caller (no header = anonymous). */
async function call(sub: string | null, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${apiBase}/api/linkedin-assistant${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sub ? { 'x-fixture-sub': sub } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Files a ticket exactly as social/routes/linkedin-content-queue.js does, under the signed-in owner's identity. */
async function queueTicket(owner: string, extra: Record<string, unknown> = {}): Promise<InternalTicket> {
  return runWithRequestIdentity({ sub: owner, isOperator: false }, () => tickets.createTicket({
    title: 'LinkedIn post: queue bridge', description: 'queue bridge', ticketType: LINKEDIN_CONTENT_QUEUE_WORKFLOW,
    status: 'approved', priority: 'none', labels: ['social', 'linkedin-content'], ownerSub: owner,
    workspaceId: null, assignedAgentId: null, parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: 'linkedin-content-queue', topic: 'queue bridge', goal: null, tone: null, sourceUrl: CITATIONS[0], sourceCitations: CITATIONS, ...extra },
  }));
}

/** Reads a ticket in the queue manager's system context (tickets are FORCE-RLS). */
async function readTicket(ticketId: string): Promise<InternalTicket> {
  return (await runWithSystemIdentity(() => tickets.getTicket(ticketId)))!;
}

/** Dispatches through the real manifest-worker dispatcher in the queue manager's system context; returns the bot-node double's execute spy. */
async function dispatch(ticket: InternalTicket, workflow: WorkflowDefinition = registry.resolve(LINKEDIN_CONTENT_QUEUE_WORKFLOW)!) {
  const execute = vi.fn(async () => ({ success: true, response: DRAFT_BODY, provider: 'fixture', model: 'fixture-only' }));
  await runWithSystemIdentity(() => dispatchManifestWorkerTicket(ticket, workflow, {
    activeTicketIds: new Set<string>(), dispatchStartTimes: new Map<string, number>(), ticketService: tickets, taskStore, messageStore,
    resolveBrain: async () => ({ kind: 'hosted' as const, connection: { baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture-only' } }),
    bindWorker: bindLinkedInContentWorker(runtimePool, judge as never, tickets),
    resolveAgentIdByName: async (name) => (name === 'social-writer' ? LINKEDIN_CONTENT_QUEUE_AGENT_ID : undefined),
    botNodeClient: { execute, hasEndpoint: () => true, isDelegationEnforced: () => true } as unknown as BotNodeClient,
  }));
  return execute;
}

/** Reads rows as the trusted system context would; RLS scoping is asserted separately. */
async function asSystem<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runWithSystemIdentity(async () => (await runtimePool.query(sql, params)).rows as T[]);
}

/** The draft's audit rows, joined the way an operator would: owner + params hash + declared action. */
async function joinedAudit(draftId: number): Promise<string[]> {
  const rows = await asSystem<{ status: string }>(
    `SELECT a.status FROM social_content_drafts d
       JOIN connector_action_audit a ON a.user_sub = d.user_sub AND a.params_hash = d.publish_params_hash
        AND a.connector_id = 'linkedin' AND a.action = 'create-post'
      WHERE d.id = $1 ORDER BY a.ts ASC`, [draftId]);
  return rows.map((row) => row.status);
}

/** Queue, dispatch and approve one owner's ticket; returns the scheduled draft id. */
async function scheduledDraftFor(owner: string): Promise<{ ticket: InternalTicket; draftId: number }> {
  const ticket = await queueTicket(owner);
  await dispatch(ticket);
  const [draft] = (await call(owner, 'GET', '/drafts?state=pending-approval')).body.drafts
    .filter((d: { sourceTicketId: string }) => d.sourceTicketId === ticket.ticketId);
  expect((await call(owner, 'POST', `/drafts/${draft.id}/approve`)).status).toBe(200);
  return { ticket, draftId: draft.id };
}

beforeAll(async () => {
  vi.stubEnv('FORCE_LLM_PROVIDER', '');
  for (const name of ['DATABASE_URL', 'PGHOST', 'POSTGRES_HOST']) vi.stubEnv(name, '');
  // Envelope crypto derives the master KEK from this; minted here so nothing literal is stored.
  vi.stubEnv('SESSION_SECRET', randomUUID());
  const owner = await fixture.start();
  // The ticket tables are not the boundary under test: they are created by the fixture owner and
  // the runtime role gets ordinary DML on them, as it does on a provisioned box.
  await ensureTicketSchema(owner);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  await owner.query(`REVOKE UPDATE, DELETE ON connector_action_audit FROM ${ROLE}`);
  // As app-role provisioning leaves it: the runtime role owns the table, and FORCE RLS still binds it.
  await owner.query(`ALTER TABLE social_content_drafts OWNER TO ${ROLE}`);
  runtimePool = wrapPoolWithGuc(fixture.rolePool(ROLE));
  await runWithSystemIdentity(() => ensureConnectionsSchema(runtimePool as AppContext['pool']));
  tickets = new TicketService(new PostgresTicketStore(runtimePool));
  await connect(OWNER, OWNER_TOKEN, 'li-owner-1');
  await connect(REJECTED, REJECTED_TOKEN, 'li-rejected-1');
  await startProvider();
  const shipped = loadConnectorSpec(path.join(process.cwd(), 'swarm-apps/connectors/linkedin.yaml'));
  linkedinSpec = { ...shipped, baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}` };
  await startApi({ pool: runtimePool, ticketService: tickets, orchestrator: judge } as unknown as AppContext);
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  registry.registerFromApp('social', SOCIAL_WORKFLOW);
}, 240_000);

afterAll(async () => {
  registry.unregisterApp('social');
  await new Promise((done) => (api ? api.close(() => done(null)) : done(null)));
  await new Promise((done) => (provider ? provider.close(() => done(null)) : done(null)));
  await fixture.stop();
  vi.unstubAllEnvs();
});

describe('LinkedIn queue ticket to confirmation-gated publish', () => {
  it('routes a registered Social ticket through the real dispatcher into an owner-scoped pending-approval draft', async () => {
    expect(chooseDispatchPath(LINKEDIN_CONTENT_QUEUE_WORKFLOW, registry.resolve(LINKEDIN_CONTENT_QUEUE_WORKFLOW), new Set(BUILT_IN_TICKET_TYPES))).toBe('manifest-worker');
    ownerTicket = await queueTicket(OWNER);
    const execute = await dispatch(ownerTicket);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toMatchObject([LINKEDIN_CONTENT_QUEUE_AGENT_ID, { userSub: OWNER, direct: true, agenticMode: false }]);
    expect(JSON.stringify(execute.mock.calls[0])).toContain(CITATIONS[1]);
    const { drafts } = (await call(OWNER, 'GET', '/drafts?state=pending-approval')).body;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ sourceTicketId: ownerTicket.ticketId, sourceCitations: CITATIONS, body: DRAFT_BODY, judgeMode: 'llm', score: 84 });
    ownerDraftId = drafts[0].id;
    const ticket = await readTicket(ownerTicket.ticketId);
    expect(ticket.status).toBe('complete');
    expect(ticket.metadata[LINKEDIN_TICKET_PROVENANCE_KEY]).toEqual({ draftId: ownerDraftId, sourceCitations: CITATIONS });
  }, 60_000);

  it('is idempotent on retry and under a concurrent insert race, fenced by the real unique owner/ticket index', async () => {
    const execute = await dispatch(ownerTicket);
    expect(execute).not.toHaveBeenCalled();
    const raced = await queueTicket(OWNER);
    const bind = bindLinkedInContentWorker(runtimePool, judge as never, tickets);
    await runWithSystemIdentity(async () => {
      const [a, b] = await Promise.all([bind(raced, SOCIAL_WORKFLOW, LINKEDIN_CONTENT_QUEUE_AGENT_ID), bind(raced, SOCIAL_WORKFLOW, LINKEDIN_CONTENT_QUEUE_AGENT_ID)]);
      await Promise.all([a!.complete(DRAFT_BODY), b!.complete(DRAFT_BODY)]);
    });
    const rows = await asSystem('SELECT id FROM social_content_drafts WHERE user_sub = $1 AND source_ticket_id = $2', [OWNER, raced.ticketId]);
    expect(rows).toHaveLength(1);
    expect((await readTicket(raced.ticketId)).metadata[LINKEDIN_TICKET_PROVENANCE_KEY]).toMatchObject({ draftId: rows[0].id });
  }, 60_000);

  it('denies another owner, an anonymous caller and an unapproved publish, and never reaches the provider', async () => {
    for (const [method, route] of [['GET', `/drafts/${ownerDraftId}`], ['POST', `/drafts/${ownerDraftId}/approve`], ['POST', `/drafts/${ownerDraftId}/reject`]]) {
      expect((await call(OTHER, method, route)).status).toBe(404);
    }
    expect((await call(OTHER, 'POST', `/drafts/${ownerDraftId}/publish`, { confirm: true })).status).toBe(404);
    expect((await call(OTHER, 'GET', '/drafts')).body.drafts).toEqual([]);
    expect((await call(null, 'GET', '/drafts')).status).toBe(401);
    expect((await call(OWNER, 'POST', `/drafts/${ownerDraftId}/publish`, {})).status).toBe(428);
    expect((await call(OWNER, 'POST', `/drafts/${ownerDraftId}/publish`, { confirm: true })).status).toBe(409);
    expect(providerCalls).toEqual([]);
    // Self-validation: if this INSERT succeeded, every owner-scope assertion above would be vacuous.
    await expect(runWithRequestIdentity({ sub: OTHER, isOperator: false }, () => runtimePool.query(
      `INSERT INTO social_content_drafts (user_sub, topic, body) VALUES ($1, 'forged', 'forged')`, [OWNER],
    ))).rejects.toMatchObject({ code: '42501' });
  }, 60_000);

  it('approves, holds the publish at the 428 confirm gate, then publishes on the caller credential with joinable audit rows', async () => {
    expect((await call(OWNER, 'POST', `/drafts/${ownerDraftId}/approve`)).body.draft.state).toBe('scheduled');
    expect((await call(OWNER, 'POST', `/drafts/${ownerDraftId}/publish`, {})).status).toBe(428);
    expect(providerCalls).toEqual([]);
    const published = await call(OWNER, 'POST', `/drafts/${ownerDraftId}/publish`, { confirm: true });
    expect(published.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({ method: 'POST', path: '/v2/ugcPosts', authorization: `Bearer ${OWNER_TOKEN}`, restli: '2.0.0' });
    expect(providerCalls[0].body).toMatchObject({ author: 'urn:li:person:li-owner-1', lifecycleState: 'PUBLISHED' });
    expect(providerCalls[0].body.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text).toBe(DRAFT_BODY);
    expect(published.body.draft).toMatchObject({ state: 'published', publishedPostId: 'urn:li:share:1', sourceTicketId: ownerTicket.ticketId });
    expect(published.body.draft.publishParamsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await joinedAudit(ownerDraftId)).toEqual(['attempt', 'success']);
    const [audit] = await asSystem('SELECT params_hash FROM connector_action_audit WHERE user_sub = $1', [OWNER]);
    expect(JSON.stringify(audit)).not.toContain('queue bridge');
    expect((await readTicket(ownerTicket.ticketId)).metadata[LINKEDIN_TICKET_PROVENANCE_KEY]).toMatchObject({
      draftId: ownerDraftId, sourceCitations: CITATIONS,
      publish: { status: 'published', postId: 'urn:li:share:1', paramsHash: published.body.draft.publishParamsHash, message: null },
    });
    // Published is terminal: a second confirmed publish is refused and posts nothing.
    expect((await call(OWNER, 'POST', `/drafts/${ownerDraftId}/publish`, { confirm: true })).status).toBe(409);
    expect(providerCalls).toHaveLength(1);
  }, 60_000);

  it('gives an owner with no LinkedIn connection a clean skip: nothing sent, no audit row, draft kept', async () => {
    const before = providerCalls.length;
    const { ticket, draftId } = await scheduledDraftFor(UNCONNECTED);
    const skipped = await call(UNCONNECTED, 'POST', `/drafts/${draftId}/publish`, { confirm: true });
    expect(skipped.status).toBe(409);
    expect(skipped.body).toMatchObject({ ok: false, skipped: true, draft: { state: 'scheduled', publishParamsHash: null } });
    expect(skipped.body.message).toMatch(/Connect LinkedIn/);
    expect(providerCalls).toHaveLength(before);
    expect(await asSystem('SELECT 1 FROM connector_action_audit WHERE user_sub = $1', [UNCONNECTED])).toEqual([]);
    expect((await readTicket(ticket.ticketId)).metadata[LINKEDIN_TICKET_PROVENANCE_KEY]).toMatchObject({ publish: { status: 'skipped', postId: null } });
  }, 60_000);

  it('records a provider rejection as a failed attempt the draft still joins to its audit rows', async () => {
    const { ticket, draftId } = await scheduledDraftFor(REJECTED);
    const refused = await call(REJECTED, 'POST', `/drafts/${draftId}/publish`, { confirm: true });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.draft).toMatchObject({ state: 'scheduled', publishedPostId: null });
    expect(await joinedAudit(draftId)).toEqual(['attempt', 'error']);
    expect((await readTicket(ticket.ticketId)).metadata[LINKEDIN_TICKET_PROVENANCE_KEY]).toMatchObject({
      publish: { status: 'failed', postId: null, paramsHash: refused.body.draft.publishParamsHash },
    });
  }, 60_000);

  it('refuses a forged ticket and a workflow registered without the manifest-worker pipeline, creating no draft', async () => {
    const forged = await queueTicket(OWNER, { providerIntent: { kind: 'forged' } });
    const withoutPipeline = await queueTicket(OWNER);
    const { pipeline: _omitted, ...social150 } = SOCIAL_WORKFLOW;
    for (const [ticket, workflow] of [[forged, SOCIAL_WORKFLOW], [withoutPipeline, social150 as WorkflowDefinition]] as const) {
      const execute = await dispatch(ticket, workflow);
      expect(execute).not.toHaveBeenCalled();
      expect((await readTicket(ticket.ticketId)).status).toBe('escalated');
      expect(await asSystem('SELECT 1 FROM social_content_drafts WHERE source_ticket_id = $1', [ticket.ticketId])).toEqual([]);
    }
  }, 60_000);
});
