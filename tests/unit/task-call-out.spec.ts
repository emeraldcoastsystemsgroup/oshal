/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-083 call-out resolver contract: a confident owner claim wins; unclaimed tasks land on the general fallback (never the PM); the PM / Jarvis brain / privileged dev bot can never win a generic task; failures degrade to null (workflow default) instead of throwing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | fix(a2a): review finding (CRITICAL) regression coverage — an a2a-gateway-sourced ticket must be role-gated identically to a jarvis-sourced one (ADR-087 ROLE_GATED_TICKET_SOURCES), so an operator/swarm-scoped bot can never be call-out-dispatched by an external A2A credential holder.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildTaskCallOutResolver, GENERAL_FALLBACK_AGENT_ID } from '../../src/features/swarm-orchestration/services/task-call-out';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';

const TRADING = 'a0000000-0000-0000-0000-000000000046';
const EATS = 'b0080000-0000-0000-0000-000000000001';
const SHOPPING = 'b0070000-0000-0000-0000-000000000001';
const PM = 'a0000000-0000-0000-0000-000000000001';
const DEV_BOT = 'de000000-0000-0000-0000-000000000001';

function ticket(overrides: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: 't-1',
    title: 'Audit why trading stopped near $20k',
    description: 'Trace the morning timeline: cap seen, target exposure, actual exposure.',
    status: 'approved',
    metadata: { complexity: 'simple' },
    ...overrides,
  } as InternalTicket;
}

function makeRepo(agents: Array<{ agentId: string; name: string }>) {
  return {
    listAgents: vi.fn().mockResolvedValue(agents.map((a) => ({
      ...a, status: 'active', baseCapabilities: [], routingKeywords: [], selectorDescriptor: '',
    }))),
  } as never;
}

describe('buildTaskCallOutResolver (ADR-083)', () => {
  it('returns a confident claim when a knowledge owner wins the bid tier', async () => {
    const resolver = buildTaskCallOutResolver({
      agentRouter: {
        route: vi.fn().mockResolvedValue({ winner: { agentId: TRADING, score: 1, reason: '' }, ranked: [], strategy: 'bid' }),
      } as never,
      meshBidBroadcaster: {
        broadcastBidRequest: vi.fn().mockResolvedValue({ claims: [], lead: null }),
        toBids: vi.fn().mockReturnValue([{ agentId: TRADING, confidence: 0.8, estimatedCost: 0, estimatedLatencyMs: 0 }]),
      } as never,
      agentProfileRepository: makeRepo([{ agentId: TRADING, name: 'trading-analyst' }]),
      resolveOnlineAgentIds: async () => [TRADING],
    });
    const result = await resolver(ticket());
    expect(result).toEqual({
      agentId: TRADING,
      agentName: 'trading-analyst',
      owners: [{ agentId: TRADING, agentName: 'trading-analyst', confidence: 0.8 }],
      strategy: 'bid',
      confident: true,
    });
  });

  it('exposes only registry-backed qualified bids within 0.15 of the lead', async () => {
    const resolver = buildTaskCallOutResolver({
      agentRouter: {
        route: vi.fn().mockResolvedValue({ winner: { agentId: EATS, score: 1, reason: '' }, ranked: [], strategy: 'bid' }),
      } as never,
      meshBidBroadcaster: {
        broadcastBidRequest: vi.fn().mockResolvedValue({ claims: [], lead: null }),
        toBids: vi.fn().mockReturnValue([
          { agentId: EATS, confidence: 0.65, estimatedCost: 0, estimatedLatencyMs: 10 },
          { agentId: SHOPPING, confidence: 0.60, estimatedCost: 0, estimatedLatencyMs: 20 },
          { agentId: PM, confidence: 0.64, estimatedCost: 0, estimatedLatencyMs: 5 },
          { agentId: TRADING, confidence: 0.49, estimatedCost: 0, estimatedLatencyMs: 1 },
        ]),
      } as never,
      agentProfileRepository: makeRepo([
        { agentId: EATS, name: 'eats-concierge' },
        { agentId: SHOPPING, name: 'shopping-concierge' },
        { agentId: PM, name: 'project-manager' },
        { agentId: TRADING, name: 'trading-analyst' },
      ]),
      resolveOnlineAgentIds: async () => [EATS, SHOPPING, PM, TRADING],
    });

    const result = await resolver(ticket({
      title: "Order Ben & Jerry's ice cream and fish food",
      description: 'Use Uber Eats for ice cream and a shopping provider for fish food.',
    }));

    expect(result?.owners).toEqual([
      { agentId: EATS, agentName: 'eats-concierge', confidence: 0.65 },
      { agentId: SHOPPING, agentName: 'shopping-concierge', confidence: 0.60 },
    ]);
  });

  it('caps ranked near-lead bid owners at three', async () => {
    const owners = [
      { agentId: 'owner-1', name: 'owner-one', confidence: 0.90 },
      { agentId: 'owner-2', name: 'owner-two', confidence: 0.87 },
      { agentId: 'owner-3', name: 'owner-three', confidence: 0.85 },
      { agentId: 'owner-4', name: 'owner-four', confidence: 0.84 },
      { agentId: 'owner-5', name: 'owner-five', confidence: 0.74 },
    ];
    const resolver = buildTaskCallOutResolver({
      agentRouter: {
        route: vi.fn().mockResolvedValue({
          winner: { agentId: 'owner-1', score: 1, reason: '' },
          ranked: [],
          strategy: 'bid',
        }),
      } as never,
      meshBidBroadcaster: {
        broadcastBidRequest: vi.fn().mockResolvedValue({ claims: [], lead: null }),
        toBids: vi.fn().mockReturnValue(owners.map((owner) => ({
          agentId: owner.agentId,
          confidence: owner.confidence,
          estimatedCost: 0,
          estimatedLatencyMs: 0,
        }))),
      } as never,
      agentProfileRepository: makeRepo(owners),
      resolveOnlineAgentIds: async () => owners.map((owner) => owner.agentId),
    });

    const result = await resolver(ticket());

    expect(result?.owners).toEqual([
      { agentId: 'owner-1', agentName: 'owner-one', confidence: 0.90 },
      { agentId: 'owner-2', agentName: 'owner-two', confidence: 0.87 },
      { agentId: 'owner-3', agentName: 'owner-three', confidence: 0.85 },
    ]);
  });

  it('lands an unclaimed task on the general fallback — never the PM', async () => {
    const resolver = buildTaskCallOutResolver({
      agentRouter: {
        // score = nobody claimed it; the router just ranked the least-bad candidate.
        route: vi.fn().mockResolvedValue({ winner: { agentId: TRADING, score: 0.1, reason: '' }, ranked: [], strategy: 'score' }),
      } as never,
      agentProfileRepository: makeRepo([
        { agentId: TRADING, name: 'trading-analyst' },
        { agentId: GENERAL_FALLBACK_AGENT_ID, name: 'general-bot' },
      ]),
      resolveOnlineAgentIds: async () => [TRADING, GENERAL_FALLBACK_AGENT_ID],
    });
    const result = await resolver(ticket({ title: 'summarize this article', description: 'no owner for this' }));
    expect(result).toEqual({
      agentId: GENERAL_FALLBACK_AGENT_ID,
      agentName: 'general-bot',
      strategy: 'fallback-general',
      confident: false,
    });
  });

  it('returns null (workflow default) when unclaimed and the general fallback is offline', async () => {
    const resolver = buildTaskCallOutResolver({
      agentRouter: {
        route: vi.fn().mockResolvedValue({ winner: { agentId: TRADING, score: 0.1, reason: '' }, ranked: [], strategy: 'score' }),
      } as never,
      agentProfileRepository: makeRepo([{ agentId: TRADING, name: 'trading-analyst' }]),
      resolveOnlineAgentIds: async () => [TRADING],
    });
    expect(await resolver(ticket())).toBeNull();
  });

  it('excludes the PM, Jarvis brain, and privileged dev bot from the candidate set', async () => {
    const route = vi.fn().mockResolvedValue({ winner: { agentId: TRADING, score: 1, reason: '' }, ranked: [], strategy: 'keyword' });
    const resolver = buildTaskCallOutResolver({
      agentRouter: { route } as never,
      agentProfileRepository: makeRepo([
        { agentId: PM, name: 'project-manager' },
        { agentId: DEV_BOT, name: 'oshal-developer' },
        { agentId: TRADING, name: 'trading-analyst' },
      ]),
      resolveOnlineAgentIds: async () => [PM, DEV_BOT, TRADING],
    });
    await resolver(ticket());
    const candidates = route.mock.calls[0][1] as Array<{ agentId: string }>;
    expect(candidates.map((c) => c.agentId)).toEqual([TRADING]);
  });

  it('role-gates an a2a-gateway-sourced ticket exactly like a jarvis-sourced one (ADR-087)', async () => {
    const route = vi.fn().mockResolvedValue({ winner: { agentId: EATS, score: 1, reason: '' }, ranked: [], strategy: 'keyword' });
    const isAgentAccessibleTo = vi.fn((agentId: string) => agentId !== TRADING); // TRADING is operator/swarm-only
    const resolver = buildTaskCallOutResolver({
      agentRouter: { route } as never,
      agentProfileRepository: makeRepo([
        { agentId: TRADING, name: 'trading-research-analyst' },
        { agentId: EATS, name: 'eats-concierge' },
      ]),
      resolveOnlineAgentIds: async () => [TRADING, EATS],
      isAgentAccessibleTo,
    });

    await resolver(ticket({ metadata: { complexity: 'simple', source: 'a2a-gateway' } }));

    const candidates = route.mock.calls[0][1] as Array<{ agentId: string }>;
    expect(candidates.map((c) => c.agentId)).toEqual([EATS]);
    expect(isAgentAccessibleTo).toHaveBeenCalledWith(TRADING, 'jarvis');
    expect(isAgentAccessibleTo).toHaveBeenCalledWith(EATS, 'jarvis');
  });

  it('does NOT role-gate a ticket with no recognized external source', async () => {
    const route = vi.fn().mockResolvedValue({ winner: { agentId: TRADING, score: 1, reason: '' }, ranked: [], strategy: 'keyword' });
    const isAgentAccessibleTo = vi.fn().mockReturnValue(false);
    const resolver = buildTaskCallOutResolver({
      agentRouter: { route } as never,
      agentProfileRepository: makeRepo([{ agentId: TRADING, name: 'trading-research-analyst' }]),
      resolveOnlineAgentIds: async () => [TRADING],
      isAgentAccessibleTo,
    });

    await resolver(ticket({ metadata: { complexity: 'simple', source: 'manifest-worker' } }));

    expect(isAgentAccessibleTo).not.toHaveBeenCalled();
    const candidates = route.mock.calls[0][1] as Array<{ agentId: string }>;
    expect(candidates.map((c) => c.agentId)).toEqual([TRADING]);
  });

  it('never throws — a router failure degrades to null so the workflow default applies', async () => {
    const resolver = buildTaskCallOutResolver({
      agentRouter: { route: vi.fn().mockRejectedValue(new Error('boom')) } as never,
      agentProfileRepository: makeRepo([{ agentId: TRADING, name: 'trading-analyst' }]),
      resolveOnlineAgentIds: async () => [TRADING],
    });
    await expect(resolver(ticket())).resolves.toBeNull();
  });
});
