/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the inbound A2A gateway against mocked pg + ticket rails: default-off 404 posture (card + RPC), skill curation (ADR-087 predicate + external denylist, no agentId leak), mint-once/sha256-at-rest/revoke, bearer accept/reject/revoked/disabled, the auth-failure limiter, message/send filing a real ticket under the synthetic 'a2a:<id>' owner via the call-out lane, tasks/get state mapping (incl. dead_letter→failed) + completed-artifact projection, tasks/cancel status-model rejection, scope enforcement, and the fail-closed per-hour inbound ceiling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a regression test (review finding, CRITICAL) proving createA2aRpcHandler re-enters runWithRequestIdentity with the authenticated agent's synthetic sub — the prior version left the ambient anonymous request identity in place for the whole call, which is invisible to a bare `.query` mock (no AsyncLocalStorage) so this gap shipped past 29 green tests. Asserts via getRequestIdentity() read from inside the injected createTicket rail.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Regression tests for the limiter-key fix (security review LOW, 2026-07-19): the failure limiter now keys on a2aLimiterKey(req) = socket.remoteAddress, so rotating X-Forwarded-For (which trust-proxy surfaces as req.ip) no longer mints a fresh bucket per request. Proves: rotated-XFF failures share ONE bucket and 429 after the threshold; a different transport peer keeps its own bucket; successful auth below the threshold is unaffected and never increments the failure count.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The fake request's Host header and the card-URL echo assertion follow PLAYWRIGHT_PORT via the shared apiHost()/apiOrigin() helpers instead of hardcoded localhost:35457 literals — both sides of the round-trip read the same helper (byte-identical under the default env)
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  A2A_TOKEN_PREFIX,
  A2aAuthFailureLimiter,
  A2aCredentialsService,
  A2aRpcService,
  JSON_RPC_ERRORS,
  buildAgentCard,
  curateAgentSkills,
  hashA2aToken,
  isA2aGatewayEnabled,
  mapTicketStateToA2A,
  normalizeScopes,
  ownerSubForA2aAgent,
  readMaxInboundPerHour,
  specArtifactsFromMessages,
  type A2AAgentIdentity,
  type A2aRpcOutcome,
  type A2aTicketRails,
} from '@/features/a2a-gateway';
import { a2aLimiterKey, createAgentCardHandler, createA2aRpcHandler, type A2aRoutesDeps } from '@/app/routes/a2a-routes';
import type { InternalTicket, OshalTicketState } from '@/entities/ticket';
import type { StoredMessage } from '@/shared/types';
import { apiHost, apiOrigin } from '../helpers';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;

/** Builds a pool whose query() dispatches on SQL content, recording every call. */
function mockPool(handler: QueryHandler): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  return { pool: { query } as unknown as Pool, calls };
}

/** Minimal Express response double capturing status + body. */
function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

/** Minimal Express request double for the public handlers. */
function fakeReq(over: Partial<Record<string, unknown>> = {}): Request {
  return {
    protocol: 'http',
    ip: '10.0.0.9',
    headers: {},
    body: {},
    get: () => apiHost(),
    ...over,
  } as unknown as Request;
}

function makeTicket(over: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: '11111111-1111-4111-8111-111111111111',
    ticketType: 'task',
    title: 'A2A delegated task',
    description: 'do the thing',
    status: 'approved',
    stateGroup: 'approved',
    executionPhase: null,
    priority: 'medium',
    labels: [],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    metadata: {},
    ownerSub: ownerSubForA2aAgent('agent-1'),
    createdAt: '2026-07-18T22:00:00.000Z',
    updatedAt: '2026-07-18T22:00:00.000Z',
    ...over,
  };
}

const AGENT: A2AAgentIdentity = {
  agentId: 'agent-1',
  name: 'partner-crew',
  scopes: ['message:send', 'tasks:read', 'tasks:cancel'],
};

function rpcServiceWith(over: {
  rails?: Partial<A2aTicketRails>;
  messages?: StoredMessage[];
  countRows?: unknown[];
  countThrows?: boolean;
  env?: NodeJS.ProcessEnv;
  noPool?: boolean;
}): { svc: A2aRpcService; created: unknown[]; calls: Array<{ sql: string; params: unknown[] }> } {
  const created: unknown[] = [];
  const rails: A2aTicketRails = {
    createTicket: vi.fn(async (input) => { created.push(input); return makeTicket(); }),
    getTicket: vi.fn(async () => null),
    updateStatus: vi.fn(async () => undefined),
    ...over.rails,
  };
  const { pool, calls } = mockPool((sql) => {
    if (sql.includes('COUNT')) {
      if (over.countThrows) throw new Error('db reset');
      return { rows: over.countRows ?? [{ n: 0 }] };
    }
    return { rows: [] };
  });
  const svc = new A2aRpcService({
    pool: over.noPool ? null : pool,
    tickets: rails,
    messages: { getByTask: vi.fn(async () => over.messages ?? []) },
    env: over.env ?? ({} as NodeJS.ProcessEnv),
  });
  return { svc, created, calls };
}

function rpc(method: string, params: unknown, id: string | number = 1): unknown {
  return { jsonrpc: '2.0', id, method, params };
}

describe('gateway config — default OFF', () => {
  it('is disabled unless A2A_GATEWAY_ENABLED=true exactly', () => {
    expect(isA2aGatewayEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isA2aGatewayEnabled({ A2A_GATEWAY_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isA2aGatewayEnabled({ A2A_GATEWAY_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('inbound ceiling defaults to 20 and survives garbage', () => {
    expect(readMaxInboundPerHour({} as NodeJS.ProcessEnv)).toBe(20);
    expect(readMaxInboundPerHour({ A2A_MAX_INBOUND_PER_HOUR: '5' } as NodeJS.ProcessEnv)).toBe(5);
    expect(readMaxInboundPerHour({ A2A_MAX_INBOUND_PER_HOUR: 'lots' } as NodeJS.ProcessEnv)).toBe(20);
    expect(readMaxInboundPerHour({ A2A_MAX_INBOUND_PER_HOUR: '-3' } as NodeJS.ProcessEnv)).toBe(20);
  });
});

describe('agent card — 404 when disabled, curated when enabled', () => {
  const bots = [
    { agentId: 'a-open', name: 'research-bot', role: 'research', capabilities: ['web-research'] },
    { agentId: 'a-scoped', name: 'project-manager', role: 'project-manager', capabilities: ['orchestration'] },
    { agentId: 'a-trading', name: 'trading-analyst', role: 'trading-analyst', capabilities: ['trading-audit'] },
  ];
  const deps = (env: NodeJS.ProcessEnv): A2aRoutesDeps => ({
    pool: null,
    ticketService: { createTicket: vi.fn(), getTicket: vi.fn(), updateStatus: vi.fn() } as unknown as A2aTicketRails,
    messageStore: { getByTask: vi.fn(async () => []) },
    env,
    getBots: () => bots,
    isAccessible: (id?: string) => id !== 'a-scoped', // ADR-087 predicate: machinery scoped out
  });

  it('answers 404 when the gateway is disabled (default posture)', () => {
    const res = fakeRes();
    createAgentCardHandler(deps({} as NodeJS.ProcessEnv))(fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(404);
  });

  it('publishes a spec card whose skills exclude non-jarvis-visible AND denylisted bots', () => {
    const res = fakeRes();
    createAgentCardHandler(deps({ A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv))(fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(200);
    const card = res.body as { skills: Array<{ id: string }>; url: string; protocolVersion: string };
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.url).toBe(`${apiOrigin()}/api/a2a`);
    expect(card.skills.map((s) => s.id)).toEqual(['research-bot']);
    // No internal identifiers leak — agent UUIDs never appear anywhere on the card.
    expect(JSON.stringify(card)).not.toContain('a-open');
    expect(JSON.stringify(card)).not.toContain('a-scoped');
  });

  it('curateAgentSkills drops trading/machinery even when the predicate admits them', () => {
    const skills = curateAgentSkills(bots, () => true);
    expect(skills.map((s) => s.name)).toEqual(['research-bot']);
  });

  it('buildAgentCard declares bearer auth and the JSONRPC transport only', () => {
    const card = buildAgentCard({ baseUrl: 'https://swarm.example.com/', version: '9.9.9', bots, isAccessible: () => true });
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.securitySchemes.bearer.scheme).toBe('bearer');
    expect(card.url).toBe('https://swarm.example.com/api/a2a');
  });
});

describe('credentials — mint once, sha256 at rest, revoke, bearer checks', () => {
  it('mint stores ONLY the sha256 hash and returns the plaintext exactly once', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const svc = new A2aCredentialsService(pool);
    const minted = await svc.mint({ name: 'partner-crew' });
    expect(minted).not.toBeNull();
    expect(minted?.token.startsWith(A2A_TOKEN_PREFIX)).toBe(true);
    expect(minted?.scopes).toEqual(['message:send', 'tasks:read', 'tasks:cancel']);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO a2a_agents'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain(hashA2aToken(minted!.token));
    expect(insert?.params).not.toContain(minted!.token);
  });

  it('normalizeScopes defaults to all, narrows to known, and fails all-invalid input', () => {
    expect(normalizeScopes(undefined)).toEqual(['message:send', 'tasks:read', 'tasks:cancel']);
    expect(normalizeScopes(['tasks:read'])).toEqual(['tasks:read']);
    expect(normalizeScopes(['root'])).toBeNull();
  });

  it('revoke soft-deletes exactly once (idempotent second call reports false)', async () => {
    let live = true;
    const { pool } = mockPool((sql) => {
      if (sql.includes('SET revoked_at')) {
        const rowCount = live ? 1 : 0;
        live = false;
        return { rows: [], rowCount };
      }
      return { rows: [] };
    });
    const svc = new A2aCredentialsService(pool);
    expect(await svc.revoke('agent-1')).toBe(true);
    expect(await svc.revoke('agent-1')).toBe(false);
  });

  it('authenticate accepts a live token and attaches {agentId, scopes}', async () => {
    const token = `${A2A_TOKEN_PREFIX}${'ab'.repeat(24)}`;
    const { pool } = mockPool((sql, params) => {
      if (sql.includes('FROM a2a_agents') && params[0] === hashA2aToken(token)) {
        return { rows: [{ id: 'agent-1', name: 'partner-crew', token_hash: hashA2aToken(token), scopes: ['tasks:read'] }] };
      }
      return { rows: [] };
    });
    const svc = new A2aCredentialsService(pool);
    const identity = await svc.authenticate(token);
    expect(identity).toEqual({ agentId: 'agent-1', name: 'partner-crew', scopes: ['tasks:read'] });
  });

  it('authenticate rejects unknown tokens, and its lookup filters enabled + not-revoked', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const svc = new A2aCredentialsService(pool);
    expect(await svc.authenticate(`${A2A_TOKEN_PREFIX}deadbeef`)).toBeNull();
    const lookup = calls.find((c) => c.sql.includes('FROM a2a_agents'));
    expect(lookup?.sql).toContain('enabled = TRUE');
    expect(lookup?.sql).toContain('revoked_at IS NULL');
  });

  it('authenticate rejects non-prefixed tokens without touching the database', async () => {
    const { pool, calls } = mockPool(() => ({ rows: [] }));
    const svc = new A2aCredentialsService(pool);
    expect(await svc.authenticate('oshal_pat_notours')).toBeNull();
    expect(calls.filter((c) => c.sql.includes('FROM a2a_agents'))).toHaveLength(0);
  });
});

describe('auth failure limiter', () => {
  it('blocks a key after the failure budget inside the window, and forgets after it', () => {
    let now = 1_000_000;
    const limiter = new A2aAuthFailureLimiter(3, 60_000, () => now);
    expect(limiter.isLimited('ip-1')).toBe(false);
    limiter.recordFailure('ip-1');
    limiter.recordFailure('ip-1');
    expect(limiter.isLimited('ip-1')).toBe(false);
    limiter.recordFailure('ip-1');
    expect(limiter.isLimited('ip-1')).toBe(true);
    expect(limiter.isLimited('ip-2')).toBe(false);
    now += 61_000;
    expect(limiter.isLimited('ip-1')).toBe(false);
  });
});

describe('JSON-RPC message/send — files a REAL ticket on the call-out rails', () => {
  const params = { message: { role: 'user', parts: [{ kind: 'text', text: 'Summarize the k8s runbook drift' }], messageId: 'm-1' } };

  it('creates ticketType task / status approved / synthetic ownerSub and returns the task id', async () => {
    const { svc, created } = rpcServiceWith({});
    const out = await svc.handle(rpc('message/send', params), AGENT);
    expect(out.httpStatus).toBe(200);
    expect(out.body.result).toMatchObject({ id: makeTicket().ticketId, kind: 'task', status: { state: 'submitted' } });
    expect(created).toHaveLength(1);
    const input = created[0] as Record<string, unknown>;
    expect(input.ticketType).toBe('task');
    expect(input.status).toBe('approved');
    expect(input.ownerSub).toBe('a2a:agent-1');
    expect(input.assignedAgentId).toBeNull(); // call-out routed — the gateway never names a bot
    expect(String(input.description)).toContain('[A2A INBOUND TASK]');
    expect(String(input.description)).toContain('Summarize the k8s runbook drift');
  });

  it('rejects a message with no text parts as INVALID_PARAMS', async () => {
    const { svc, created } = rpcServiceWith({});
    const out = await svc.handle(rpc('message/send', { message: { parts: [{ kind: 'file', uri: 'x' }] } }), AGENT);
    expect(out.body.error?.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(created).toHaveLength(0);
  });

  it('enforces the per-agent hourly ceiling with HTTP 429', async () => {
    const { svc, created } = rpcServiceWith({ countRows: [{ n: 20 }] });
    const out = await svc.handle(rpc('message/send', params), AGENT);
    expect(out.httpStatus).toBe(429);
    expect(out.body.error?.code).toBe(JSON_RPC_ERRORS.RATE_LIMITED);
    expect(created).toHaveLength(0);
  });

  it('honors A2A_MAX_INBOUND_PER_HOUR', async () => {
    const env = { A2A_MAX_INBOUND_PER_HOUR: '2' } as NodeJS.ProcessEnv;
    const { svc } = rpcServiceWith({ countRows: [{ n: 2 }], env });
    const out = await svc.handle(rpc('message/send', params), AGENT);
    expect(out.httpStatus).toBe(429);
  });

  it('FAILS CLOSED to 429 when the ceiling count is unreadable', async () => {
    const broken = rpcServiceWith({ countThrows: true });
    expect((await broken.svc.handle(rpc('message/send', params), AGENT)).httpStatus).toBe(429);
    const poolless = rpcServiceWith({ noPool: true });
    expect((await poolless.svc.handle(rpc('message/send', params), AGENT)).httpStatus).toBe(429);
  });

  it('denies the method with -32004 / HTTP 403 when the credential lacks message:send', async () => {
    const { svc, created } = rpcServiceWith({});
    const readOnly: A2AAgentIdentity = { ...AGENT, scopes: ['tasks:read'] };
    const out = await svc.handle(rpc('message/send', params), readOnly);
    expect(out.httpStatus).toBe(403);
    expect(out.body.error?.code).toBe(JSON_RPC_ERRORS.UNSUPPORTED_OPERATION);
    expect(created).toHaveLength(0);
  });
});

describe('JSON-RPC tasks/get — state mapping + artifacts', () => {
  function getOutcome(status: OshalTicketState, messages: StoredMessage[] = []): Promise<A2aRpcOutcome> {
    const ticket = makeTicket({ status });
    const { svc } = rpcServiceWith({ rails: { getTicket: vi.fn(async () => ticket) }, messages });
    return svc.handle(rpc('tasks/get', { id: ticket.ticketId }), AGENT);
  }

  it('maps the full internal lifecycle onto spec TaskStates (dead_letter → failed)', () => {
    expect(mapTicketStateToA2A('backlog')).toBe('submitted');
    expect(mapTicketStateToA2A('approved')).toBe('submitted');
    expect(mapTicketStateToA2A('in_process_build')).toBe('working');
    expect(mapTicketStateToA2A('escalated')).toBe('working');
    expect(mapTicketStateToA2A('approval_required')).toBe('input-required');
    expect(mapTicketStateToA2A('complete')).toBe('completed');
    expect(mapTicketStateToA2A('dead_letter')).toBe('failed');
    expect(mapTicketStateToA2A('cancelled')).toBe('canceled');
  });

  it('returns working for an in-process ticket, failed for dead_letter', async () => {
    expect(((await getOutcome('in_process_build')).body.result as { status: { state: string } }).status.state).toBe('working');
    expect(((await getOutcome('dead_letter')).body.result as { status: { state: string } }).status.state).toBe('failed');
  });

  it('projects the trusted bot-node completion message into artifacts on completed', async () => {
    const messages = [
      { messageId: 'm-a', taskId: 't', role: 'assistant', type: 'text', text: 'working on it…', contentBlocks: [], metadata: {}, createdAt: '2026-07-18T22:00:00.000Z' },
      { messageId: 'm-b', taskId: 't', role: 'assistant', type: 'text', text: 'Final deliverable: drift report attached.', contentBlocks: [], metadata: { source: 'manifest-worker-bot-node', manifestWorkerResult: true }, createdAt: '2026-07-18T22:05:00.000Z' },
    ] as StoredMessage[];
    const out = await getOutcome('complete', messages);
    const task = out.body.result as { status: { state: string }; artifacts?: Array<{ artifactId: string; parts: Array<{ text: string }> }> };
    expect(task.status.state).toBe('completed');
    expect(task.artifacts?.[0]?.artifactId).toBe('m-b');
    expect(task.artifacts?.[0]?.parts[0]?.text).toContain('Final deliverable');
  });

  it('specArtifactsFromMessages returns [] when nothing readable exists', () => {
    expect(specArtifactsFromMessages([])).toEqual([]);
  });

  it('hides foreign tickets behind TASK_NOT_FOUND (no existence oracle)', async () => {
    const foreign = makeTicket({ ownerSub: 'a2a:someone-else' });
    const { svc } = rpcServiceWith({ rails: { getTicket: vi.fn(async () => foreign) } });
    const out = await svc.handle(rpc('tasks/get', { id: foreign.ticketId }), AGENT);
    expect(out.body.error?.code).toBe(JSON_RPC_ERRORS.TASK_NOT_FOUND);
  });
});

describe('JSON-RPC tasks/cancel', () => {
  it('cancels an owned, cancelable ticket and returns state canceled', async () => {
    const ticket = makeTicket({ status: 'approved' });
    const updateStatus = vi.fn(async () => undefined);
    const { svc } = rpcServiceWith({ rails: { getTicket: vi.fn(async () => ticket), updateStatus } });
    const out = await svc.handle(rpc('tasks/cancel', { id: ticket.ticketId }), AGENT);
    expect(updateStatus).toHaveBeenCalledWith(ticket.ticketId, 'cancelled', expect.anything());
    expect((out.body.result as { status: { state: string } }).status.state).toBe('canceled');
  });

  it('rejects with TASK_NOT_CANCELABLE when the status model refuses the transition', async () => {
    const ticket = makeTicket({ status: 'complete' });
    const updateStatus = vi.fn(async () => { throw new Error('Invalid state transition: complete → cancelled'); });
    const { svc } = rpcServiceWith({ rails: { getTicket: vi.fn(async () => ticket), updateStatus } });
    const out = await svc.handle(rpc('tasks/cancel', { id: ticket.ticketId }), AGENT);
    expect(out.body.error?.code).toBe(JSON_RPC_ERRORS.TASK_NOT_CANCELABLE);
  });
});

describe('JSON-RPC envelope + endpoint auth', () => {
  it('rejects a malformed envelope with INVALID_REQUEST and unknown methods with METHOD_NOT_FOUND', async () => {
    const { svc } = rpcServiceWith({});
    expect((await svc.handle({ nonsense: true }, AGENT)).body.error?.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect((await svc.handle(rpc('tasks/resubscribe', {}), AGENT)).body.error?.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  it('RPC endpoint is a 404 no-op when the gateway is disabled', async () => {
    const res = fakeRes();
    const handler = createA2aRpcHandler({
      pool: null,
      ticketService: { createTicket: vi.fn(), getTicket: vi.fn(), updateStatus: vi.fn() } as unknown as A2aTicketRails,
      messageStore: { getByTask: vi.fn(async () => []) },
      env: {} as NodeJS.ProcessEnv,
    });
    await handler(fakeReq(), res, vi.fn());
    expect(res.statusCode).toBe(404);
  });

  it('RPC endpoint 401s an unknown bearer, then 429s the caller after repeated failures', async () => {
    const limiter = new A2aAuthFailureLimiter(2, 60_000);
    const credentials = { authenticate: vi.fn(async () => null) } as unknown as A2aCredentialsService;
    const handler = createA2aRpcHandler({
      pool: null,
      ticketService: { createTicket: vi.fn(), getTicket: vi.fn(), updateStatus: vi.fn() } as unknown as A2aTicketRails,
      messageStore: { getByTask: vi.fn(async () => []) },
      env: { A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv,
      credentials,
      limiter,
    });
    const req = fakeReq({ headers: { authorization: `Bearer ${A2A_TOKEN_PREFIX}wrong` }, body: rpc('tasks/get', { id: 'x' }) });
    const first = fakeRes();
    await handler(req, first, vi.fn());
    expect(first.statusCode).toBe(401);
    const second = fakeRes();
    await handler(req, second, vi.fn());
    expect(second.statusCode).toBe(401);
    const third = fakeRes();
    await handler(req, third, vi.fn());
    expect(third.statusCode).toBe(429);
  });

  it('a2aLimiterKey derives from the transport socket, falls back to unknown, and ignores req.ip', () => {
    expect(a2aLimiterKey(fakeReq())).toBe('unknown');
    expect(a2aLimiterKey(fakeReq({ socket: { remoteAddress: '198.51.100.7' } }))).toBe('198.51.100.7');
    // req.ip (trust-proxy / X-Forwarded-For derived) must never influence the key.
    expect(a2aLimiterKey(fakeReq({ ip: '6.6.6.6', socket: { remoteAddress: '198.51.100.7' } }))).toBe('198.51.100.7');
  });

  it('scopes the RLS request identity to the authenticated agent — never the ambient anonymous caller', async () => {
    const credentials = { authenticate: vi.fn(async () => AGENT) } as unknown as A2aCredentialsService;
    let seenIdentity: { sub: string | null; isOperator: boolean } | undefined;
    const ticketService = {
      createTicket: vi.fn(async () => {
        seenIdentity = getRequestIdentity();
        return makeTicket();
      }),
      getTicket: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as A2aTicketRails;
    const { pool } = mockPool(() => ({ rows: [{ n: 0 }] }));
    const handler = createA2aRpcHandler({
      pool,
      ticketService,
      messageStore: { getByTask: vi.fn(async () => []) },
      env: { A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv,
      credentials,
    });
    const params = { message: { role: 'user', parts: [{ kind: 'text', text: 'hello' }] } };
    const req = fakeReq({ headers: { authorization: `Bearer ${A2A_TOKEN_PREFIX}${'ab'.repeat(24)}` }, body: rpc('message/send', params) });
    // The ambient identity when the handler is invoked (e.g. under server.ts's global RLS
    // middleware) is anonymous — the handler must NOT let that identity leak into DB calls.
    await runWithRequestIdentity({ sub: '', isOperator: false }, () => handler(req, fakeRes(), vi.fn()));
    expect(seenIdentity).toEqual({ sub: 'a2a:agent-1', isOperator: false });
  });
});

describe('limiter keying — rotated X-Forwarded-For cannot escape the failure bucket', () => {
  const GOOD_TOKEN = `${A2A_TOKEN_PREFIX}${'ab'.repeat(24)}`;

  /** Builds the RPC handler with an injected limiter + an authenticate stub that only accepts GOOD_TOKEN. */
  function limiterHandler(limiter: A2aAuthFailureLimiter) {
    const credentials = {
      authenticate: vi.fn(async (token: string) => (token === GOOD_TOKEN ? AGENT : null)),
    } as unknown as A2aCredentialsService;
    const { pool } = mockPool(() => ({ rows: [{ n: 0 }] }));
    return createA2aRpcHandler({
      pool,
      ticketService: {
        createTicket: vi.fn(async () => makeTicket()),
        getTicket: vi.fn(async () => null),
        updateStatus: vi.fn(),
      } as unknown as A2aTicketRails,
      messageStore: { getByTask: vi.fn(async () => []) },
      env: { A2A_GATEWAY_ENABLED: 'true' } as NodeJS.ProcessEnv,
      credentials,
      limiter,
    });
  }

  /** A request whose trust-proxy-derived req.ip is attacker-chosen but whose socket is fixed. */
  function reqFrom(socketAddr: string, spoofedIp: string, token: string) {
    return fakeReq({
      ip: spoofedIp, // what `trust proxy` derives from a client-controlled X-Forwarded-For
      socket: { remoteAddress: socketAddr },
      headers: { authorization: `Bearer ${token}` },
      body: rpc('tasks/get', { id: '11111111-1111-4111-8111-111111111111' }),
    });
  }

  it('failures with ROTATED XFF values land in ONE bucket and 429 after the threshold', async () => {
    const limiter = new A2aAuthFailureLimiter(3, 60_000);
    const handler = limiterHandler(limiter);
    for (const spoofed of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const res = fakeRes();
      await handler(reqFrom('198.51.100.7', spoofed, `${A2A_TOKEN_PREFIX}wrong`), res, vi.fn());
      expect(res.statusCode, `pre-threshold failure from spoofed ${spoofed}`).toBe(401);
    }
    // Fourth attempt rotates the header yet again — same socket, same (now full) bucket.
    const blocked = fakeRes();
    await handler(reqFrom('198.51.100.7', '4.4.4.4', `${A2A_TOKEN_PREFIX}wrong`), blocked, vi.fn());
    expect(blocked.statusCode).toBe(429);
  });

  it('a different transport peer keeps its own bucket (legit direct callers unaffected)', async () => {
    const limiter = new A2aAuthFailureLimiter(2, 60_000);
    const handler = limiterHandler(limiter);
    for (let i = 0; i < 2; i += 1) {
      await handler(reqFrom('198.51.100.7', `9.9.9.${i}`, `${A2A_TOKEN_PREFIX}wrong`), fakeRes(), vi.fn());
    }
    const blocked = fakeRes();
    await handler(reqFrom('198.51.100.7', '9.9.9.9', `${A2A_TOKEN_PREFIX}wrong`), blocked, vi.fn());
    expect(blocked.statusCode).toBe(429);
    // A DIFFERENT socket peer — even one claiming the blocked peer's ip via XFF — is clean.
    const other = fakeRes();
    await handler(reqFrom('203.0.113.50', '198.51.100.7', GOOD_TOKEN), other, vi.fn());
    expect(other.statusCode).toBe(200);
  });

  it('successful auth below the threshold is unaffected and never counts as a failure', async () => {
    const limiter = new A2aAuthFailureLimiter(2, 60_000);
    const handler = limiterHandler(limiter);
    // One failure — under the 2-failure budget.
    const failed = fakeRes();
    await handler(reqFrom('198.51.100.7', '1.1.1.1', `${A2A_TOKEN_PREFIX}wrong`), failed, vi.fn());
    expect(failed.statusCode).toBe(401);
    // Valid bearer from the SAME socket keeps working, repeatedly — success never
    // increments the failure count, so the bucket stays under budget forever.
    for (let i = 0; i < 5; i += 1) {
      const ok = fakeRes();
      await handler(reqFrom('198.51.100.7', `2.2.2.${i}`, GOOD_TOKEN), ok, vi.fn());
      expect(ok.statusCode, `successful call ${i + 1}`).toBe(200);
    }
  });
});
