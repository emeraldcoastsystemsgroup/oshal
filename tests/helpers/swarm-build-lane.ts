/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared harness for the build-lane privileged-worker guards (ADR-081). It drives the real QueueManagerService over the real TicketService and SwarmTicketProcessingService, with fixture edges only where the lane leaves the process: an active roster that includes the developer bot, a passing verification and a mesh transport that records every envelope and delivers nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CreateInternalTicketSchema, type InternalTicket } from '@/entities/ticket';
import { AgentRouter } from '@/features/agent-management/services/agent-router';
import type { MeshEnvelope, MeshTransport } from '@/features/agent-management/services/mesh-communication-service';
import { PhaseRoutingService } from '@/features/swarm-orchestration/services/phase-routing-service';
import { QueueManagerService } from '@/features/swarm-orchestration/services/queue-manager-service';
import { SwarmTicketProcessingService } from '@/features/swarm-orchestration/services/swarm-ticket-processing-service';
import { InMemoryTicketStore } from '@/features/ticketing/services/in-memory-ticket-store';
import { TicketService } from '@/features/ticketing/services/ticket-service';

/** The oshal-developer (ADR-081): its node works in a push-capable clone of the platform for any unit it receives. */
export const DEVELOPER_BOT = 'de000000-0000-0000-0000-000000000001';
/** A build specialist on the signed hop's allowlist. */
export const CODE_DEVELOPER = 'a0000000-0000-0000-0000-000000000002';
/** The general fallback owner; Jarvis-accessible, so an ordinary user may call it directly. */
export const GENERAL_BOT = 'a0000000-0000-0000-0000-000000000099';

/** The active roster the routing handler reads, with the developer bot installed and online. */
const ROSTER = [
  { agentId: DEVELOPER_BOT, name: 'oshal-developer', status: 'active', baseCapabilities: ['implementation'], routingKeywords: ['platform'] },
  { agentId: CODE_DEVELOPER, name: 'code-developer', status: 'active', baseCapabilities: ['implementation'], routingKeywords: [] },
  { agentId: GENERAL_BOT, name: 'general-bot', status: 'active', baseCapabilities: ['general'], routingKeywords: [] },
];

/** The wired build lane and what it recorded. */
export interface SwarmBuildLane {
  tickets: TicketService;
  /** Every envelope the lane published to the mesh, in order. */
  published: MeshEnvelope[];
  /** Runs one ticket through the real queue manager's swarm dispatch, as the poll loop would. */
  dispatch(ticket: InternalTicket): Promise<void>;
  /** Removes the harness's temporary workspace root. */
  close(): void;
}

/**
 * @description A mesh transport that records every published envelope and delivers nothing.
 * @param published - The list each envelope is appended to.
 * @returns The transport.
 */
function recordingTransport(published: MeshEnvelope[]): MeshTransport {
  return {
    publish: async (envelope) => { published.push(envelope); },
    consume: async () => [],
    ack: async () => undefined,
    subscribe: () => ({ stop: () => undefined }),
  };
}

/**
 * @description The real swarm processing service with fixture edges: the roster, a passing verification and the
 * recording transport. Phase-aware routing is wired as the composition root wires it.
 * @param published - Where published envelopes are recorded.
 * @returns The processing service.
 */
function processingService(published: MeshEnvelope[]): SwarmTicketProcessingService {
  const roster = {
    listAgents: async () => ROSTER,
    getAgentProfile: async (agentId: string) => ROSTER.find((agent) => agent.agentId === agentId) ?? null,
  };
  const verification = { verify: async () => ({ status: 'passed', summary: 'fixture verification', findings: [] }) };
  const processing = new SwarmTicketProcessingService(
    {} as never, undefined, undefined, undefined, undefined, undefined, verification as never,
    undefined, undefined, undefined, undefined, recordingTransport(published), roster as never,
  );
  processing.setPhaseRoutingService(new PhaseRoutingService(new AgentRouter()));
  return processing;
}

/**
 * @description Wires the build lane. OSHAL_WORKSPACE_ROOT must not be stubbed by the caller: the harness points it at
 * its own temporary directory (restored by vi.unstubAllEnvs in the caller's afterEach).
 * @param stubEnv - The caller's vi.stubEnv, so the caller's env cleanup covers it.
 * @returns The lane.
 */
export function buildSwarmLane(stubEnv: (name: string, value: string) => unknown): SwarmBuildLane {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-build-lane-'));
  stubEnv('OSHAL_WORKSPACE_ROOT', workspaceRoot);
  const published: MeshEnvelope[] = [];
  const tickets = new TicketService(new InMemoryTicketStore());
  const queueManager = new QueueManagerService(tickets, processingService(published));
  const dispatchTicket = (queueManager as unknown as { dispatchTicket(ticket: InternalTicket): Promise<void> }).dispatchTicket;
  return {
    tickets,
    published,
    dispatch: (ticket) => dispatchTicket.call(queueManager, ticket),
    close: () => fs.rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

/**
 * @description Stores an approved direct-execution 'build' ticket straight through the ticket service, the way an
 * internal writer puts one on the queue.
 * @param tickets - The ticket service.
 * @param ownerSub - The owner.
 * @param metadata - Extra metadata, such as a PM assignment.
 * @returns The stored ticket.
 */
export function approvedBuildTicket(tickets: TicketService, ownerSub: string, metadata: Record<string, unknown>): Promise<InternalTicket> {
  return tickets.createTicket(CreateInternalTicketSchema.parse({
    title: 'Change the platform build', description: 'Small change.', ticketType: 'build', status: 'approved', ownerSub,
    metadata: { recommendedPath: 'direct-execution', ...metadata },
  }));
}

/**
 * @description The agents the lane sent work to: the target of every published envelope.
 * @param lane - The lane.
 * @returns The target agent ids, in order.
 */
export function dispatchTargets(lane: SwarmBuildLane): string[] {
  return lane.published.map((envelope) => envelope.toAgentId);
}
