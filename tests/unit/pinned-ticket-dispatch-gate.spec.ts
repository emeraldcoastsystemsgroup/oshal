/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Plan Z-08: a ticket's metadata.targetAgentId pin is authorized at dispatch against the owner's CURRENT direct entitlement, through the real dispatchManifestWorkerTicket. A non-operator's pin to a bot they may not call escalates terminally as pinned_agent_not_entitled without claiming a slot or reaching a worker. An operator owner, a pin the owner may call, and an absent owner (internal work) still dispatch to the pinned bot. An invalid owner subject is refused as pinned_ticket_owner_invalid rather than treated as internal, and a check that cannot decide is refused as pin_authorization_unavailable, never as an entitlement verdict. A caller-supplied providerAgentId field does not skip the check, malformed provider metadata never dispatches, and unpinned swarm dispatch is untouched. Admitted dispatches reach a local stub send-message server bound to localhost, never the live API. Each case resets the wrapped entitlement mock to the real implementation, so a fault queued once cannot leak between cases.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideExecuteEntitlement } from '@/app/bot-node-execute-entitlement';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import type { InternalTicket } from '@/entities/ticket';
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { refuseTicketAtDispatch } from '@/features/swarm-orchestration/services/dispatch-ticket-gates';

// The real entitlement decision, wrapped so one case can make it throw (an infrastructure fault).
vi.mock('@/app/bot-node-execute-entitlement', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/bot-node-execute-entitlement')>();
  return { ...real, decideExecuteEntitlement: vi.fn(real.decideExecuteEntitlement) };
});

const USER = 'auth0|pin-user';
const OPERATOR = 'auth0|pin-operator';
const TICKET_ID = 'pin-tix-1';
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_SUPERADMIN_SUBS', 'SWARM_SERVICE_SECRET'];
const WORKFLOW = { ticketType: 'task', name: 'Jarvis Assistant Task', pipeline: 'manifest-worker', workerBot: 'general-bot' } as never;

let savedEnv: Record<string, string | undefined>;
let stub: Server;
let port: string;
let posts: Array<Record<string, unknown>>;

/** @description A registry bot that USER may (or may not) call directly; fails loudly so the fixture cannot rot. */
function agentWhereUserAllowed(allowed: boolean): string {
  const id = getActiveRegistry().map((bot) => bot.agentId).find((agentId) => agentId
    && decideExecuteEntitlement({ userSub: USER, direct: true, targetAgentId: agentId }).allowed === allowed);
  if (!id) throw new Error(`no registry bot is ${allowed ? 'callable' : 'operator-only'} for an ordinary user`);
  return id;
}

/** @description An approved generic task ticket with the given owner and metadata. */
function makeTicket(ownerSub: string | null, metadata: Record<string, unknown>): InternalTicket {
  return { ticketId: TICKET_ID, title: 'Pinned work', description: 'do it', ticketType: 'task', status: 'approved',
    priority: 'medium', labels: [], ownerSub, metadata } as unknown as InternalTicket;
}

/** @description Dispatch deps whose only network target is the local stub. */
function makeDeps() {
  return {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    port,
    resolveAgentIdByName: vi.fn().mockResolvedValue(undefined),
    ticketService: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      linkTask: vi.fn().mockResolvedValue(undefined),
      getTasksForTicket: vi.fn().mockResolvedValue([]),
    } as never,
  };
}

/** @description The escalation reasons a dispatch wrote. */
function escalationReasons(deps: ReturnType<typeof makeDeps>): unknown[] {
  return (deps.ticketService as { updateStatus: ReturnType<typeof vi.fn> }).updateStatus.mock.calls
    .filter((call) => call[1] === 'escalated').map((call) => (call[2] as { reason?: unknown }).reason);
}

beforeEach(async () => {
  // Every case starts from the REAL entitlement decision with no queued one-time behavior, so a fault queued by one
  // case (and left unconsumed when a mutant skips the gate) cannot leak into the next case's fixture selection.
  const actual = await vi.importActual<typeof import('@/app/bot-node-execute-entitlement')>('@/app/bot-node-execute-entitlement');
  vi.mocked(decideExecuteEntitlement).mockReset();
  vi.mocked(decideExecuteEntitlement).mockImplementation(actual.decideExecuteEntitlement);
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  posts = [];
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      posts.push({ path: req.url, ...(JSON.parse(body || '{}') as Record<string, unknown>) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, response: 'stub reply', taskId: TICKET_ID }));
    });
  });
  await new Promise<void>((done) => stub.listen(0, 'localhost', () => done()));
  port = String((stub.address() as AddressInfo).port);
});

afterEach(async () => {
  stub.closeAllConnections();
  await new Promise<void>((done) => stub.close(() => done()));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('a pin is authorized at dispatch (Z-08)', () => {
  it('refuses a non-operator owner pinning a bot they may not call, terminally and without claiming a slot', async () => {
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(USER, { targetAgentId: agentWhereUserAllowed(false) }), WORKFLOW, deps as never);
    expect(escalationReasons(deps)).toEqual(['pinned_agent_not_entitled']);
    expect(deps.activeTicketIds.size).toBe(0);
    expect(deps.resolveAgentIdByName).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

  it('dispatches the same pin when the owner is an operator', async () => {
    const pin = agentWhereUserAllowed(false);
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(OPERATOR, { targetAgentId: pin }), WORKFLOW, deps as never);
    expect(posts.map((post) => post.agentId)).toEqual([pin]);
    expect(escalationReasons(deps)).not.toContain('pinned_agent_not_entitled');
  });

  it('dispatches a pin the owner may call directly', async () => {
    const pin = agentWhereUserAllowed(true);
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(USER, { targetAgentId: pin }), WORKFLOW, deps as never);
    expect(posts.map((post) => post.agentId)).toEqual([pin]);
  });

  it('treats an absent owner as internal work', async () => {
    const pin = agentWhereUserAllowed(false);
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(null, { targetAgentId: pin }), WORKFLOW, deps as never);
    expect(posts.map((post) => post.agentId)).toEqual([pin]);
  });

  it('refuses an invalid owner subject instead of treating it as internal work', async () => {
    for (const ownerSub of ['', 'user\u0000sub']) {
      const deps = makeDeps();
      await dispatchManifestWorkerTicket(makeTicket(ownerSub, { targetAgentId: agentWhereUserAllowed(false) }), WORKFLOW, deps as never);
      expect(escalationReasons(deps), JSON.stringify(ownerSub)).toEqual(['pinned_ticket_owner_invalid']);
      expect(deps.activeTicketIds.size).toBe(0);
    }
    expect(posts).toEqual([]);
  });

  it('refuses a pin it cannot decide without calling it an entitlement verdict', async () => {
    const pin = agentWhereUserAllowed(true);
    vi.mocked(decideExecuteEntitlement).mockImplementationOnce(() => { throw new Error('registry unavailable'); });
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(USER, { targetAgentId: pin }), WORKFLOW, deps as never);
    expect(escalationReasons(deps)).toEqual(['pin_authorization_unavailable']);
    expect(deps.activeTicketIds.size).toBe(0);
    expect(posts).toEqual([]);
  });

  it('does not skip the check for a caller-supplied providerAgentId field', async () => {
    const deps = makeDeps();
    const pin = agentWhereUserAllowed(false);
    await dispatchManifestWorkerTicket(makeTicket(USER, { targetAgentId: pin, providerAgentId: pin }), WORKFLOW, deps as never);
    expect(escalationReasons(deps)).toEqual(['pinned_agent_not_entitled']);
    expect(posts).toEqual([]);
  });

  it('never dispatches malformed provider metadata', async () => {
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(USER, { targetAgentId: agentWhereUserAllowed(false), providerIntent: { forged: true } }),
      WORKFLOW, deps as never);
    expect(escalationReasons(deps)).toEqual(['invalid_provider_intent']);
    expect(posts).toEqual([]);
  });

  it('leaves unpinned swarm dispatch untouched', async () => {
    const deps = makeDeps();
    await dispatchManifestWorkerTicket(makeTicket(USER, {}), WORKFLOW, deps as never);
    expect(deps.resolveAgentIdByName).toHaveBeenCalledWith('general-bot');
    expect(escalationReasons(deps)).toEqual(['manifest_worker_agent_unresolved']);
  });

  it('lets only a strictly parsed provider agent override the pin', () => {
    const pin = agentWhereUserAllowed(false);
    expect(refuseTicketAtDispatch({ ticketType: 'task', ownerSub: USER, pinnedAgentId: pin, providerAgentId: 'provider-owner-bot' })).toBeNull();
    expect(refuseTicketAtDispatch({ ticketType: 'task', ownerSub: USER, pinnedAgentId: pin })?.escalation.reason).toBe('pinned_agent_not_entitled');
  });
});
