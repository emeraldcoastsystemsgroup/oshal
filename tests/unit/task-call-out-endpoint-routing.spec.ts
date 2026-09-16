/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards BACKLOG "The `task` call-out can still hand a ticket to a controller-inline bot under signing". Drives a REAL ADR-083 call-out (real buildTaskCallOutResolver, real AgentRouter + SelectionBidService, real MeshBidBroadcaster collecting a real BID_RESPONSE) that selects an endpoint-less owner, then dispatches through the REAL dispatchManifestWorkerTicket, the REAL registry, the REAL resolveBotNodeEndpoint and a REAL BotNodeClient holding a locally generated Ed25519 signing key, over a REAL loopback bot node that records the signed token. Proves the ticket no longer escalates with the transport message 'Signed HTTP delegation requires a dedicated bot-node endpoint'; that a reachable winner still keeps the ticket (no silent ownership change); that with signing OFF nothing is rerouted; and that when no reachable worker exists at all the refusal names the ROUTING decision. The only doubles are OUTSIDE the boundary under test: the mesh reply source (a bidder's BID_RESPONSE), the agents table, and the ticket store.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'http';
import { generateKeyPairSync } from 'crypto';

// Deep module imports, not the slice barrel: the barrel pulls the whole orchestration graph and
// the dispatcher comes back undefined under the spec transform (circular re-export) — the same
// reason tests/unit/signed-delegation-core-ticket-types.spec.ts imports this way.
import { dispatchManifestWorkerTicket } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import {
  CALL_OUT_UNREACHABLE_REASON,
  CALL_OUT_UNREACHABLE_ROUTED_BY,
} from '@/features/swarm-orchestration/services/call-out-endpoint-routing';
import { buildTaskCallOutResolver } from '@/features/swarm-orchestration/services/task-call-out';
import type { WorkflowDefinition } from '@/features/swarm-orchestration/services/dispatch-routing';
import { InMemoryMeshTransport } from '@/features/swarm-orchestration/services/swarm-ticket-processing-support';
import { resolveBotNodeEndpoint } from '@/app/extensions/swarm/resolve-bot-node-endpoint';
import {
  getActiveRegistry,
  registerAppBots,
  unregisterAppBots,
  type SwarmBotDefinition,
} from '@/app/extensions/swarm/swarm-bot-registry';
import {
  AgentRouter,
  BotNodeClient,
  MeshBidBroadcaster,
  isControllerInlineContainer,
  type MeshCommunicationService,
} from '@/features/agent-management';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import type { AgentProfileRepository } from '@/entities/agent';
import type { InternalTicket } from '@/entities/ticket';

/** The transport refusal this backlog item exists to remove from the `task` lane. */
const INLINE_REFUSAL = 'Signed HTTP delegation requires a dedicated bot-node endpoint';

const SPEC_APP = '__task-call-out-endpoint-routing-spec__';
/** The owner every guard ticket is filed under. Never a real subject. */
const SPEC_OWNER_SUB = 'spec-owner-sub';

/** A bot that owns a node: `requiresOwnNode` short-circuits the codex rule, exactly like general-bot. */
const REACHABLE_WORKER: SwarmBotDefinition = {
  agentId: 'fe000000-0000-4000-8000-000000000011',
  name: '__spec-reachable-worker__',
  port: 3901,
  container: 'spec-reachable-worker-node',
  requiresOwnNode: true,
  role: 'spec/reachable',
  capabilities: ['spec'],
  harnessType: 'codex-cli',
  apiType: 'openai-codex',
} as SwarmBotDefinition;

/** The 24-bot `container: oshal-api` shape: a real registry row that resolves to no endpoint. */
const INLINE_OWNER: SwarmBotDefinition = {
  agentId: 'fe000000-0000-4000-8000-000000000012',
  name: '__spec-inline-owner__',
  port: 3902,
  container: 'oshal-api',
  role: 'spec/inline',
  capabilities: ['spec'],
  harnessType: 'codex-cli',
  apiType: 'openai-codex',
} as SwarmBotDefinition;

/**
 * The live shape this entry was filed for: self-healing-bot (a0…056) and career-hunter (cb…0001)
 * are ONLINE with a heartbeat and `status='active'` in the agents table, so they are call-out
 * candidates, but neither has a registry definition — so neither resolves to an endpoint. This id
 * is deliberately never registered.
 */
const UNREGISTERED_OWNER = {
  agentId: 'fe000000-0000-4000-8000-000000000013',
  name: '__spec-unregistered-owner__',
};

/** A DB-sourced routing candidate, as `normalizeCandidates` reads the agents table. */
interface SpecAgent { agentId: string; name: string }

/**
 * @description Stand-in for the agents table. Outside the boundary under test (the boundary is
 * the dispatcher's routing decision), and every row it returns is a spec fixture.
 * @param agents - The active agents the call-out should see as candidates.
 * @returns A repository exposing just the `listAgents` the call-out consumes.
 */
function specAgentRepository(agents: SpecAgent[]): AgentProfileRepository {
  return {
    listAgents: async () => agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      status: 'active',
      baseCapabilities: ['spec'],
      routingKeywords: [],
      selectorDescriptor: '',
    })),
  } as unknown as AgentProfileRepository;
}

/**
 * @description A mesh reply source that answers one agent's BID_REQUEST with a real BID_RESPONSE,
 * so the REAL MeshBidBroadcaster ranks a real claim and the REAL AgentRouter resolves via its bid
 * tier. Only the wire under the broadcaster is doubled; the auction itself runs for real.
 * @param bidderAgentId - The agent that claims the ticket.
 * @param confidence - Its self-scored confidence, above the router's qualification threshold.
 * @returns A MeshCommunicationService-shaped reply source.
 */
function bidderRepliesFor(bidderAgentId: string, confidence: number): MeshCommunicationService {
  return {
    request: async (envelope: { correlationId?: string; toAgentId?: string }) => {
      if (envelope.toAgentId !== bidderAgentId) throw new Error('no bid from this agent');
      return {
        correlationId: envelope.correlationId,
        fromAgentId: bidderAgentId,
        toAgentId: 'queue-manager',
        channel: 'spec',
        messageType: 'response',
        payload: { signalType: 'BID_RESPONSE', agentId: bidderAgentId, confidence },
      };
    },
  } as unknown as MeshCommunicationService;
}

interface StubNode {
  baseUrl: string;
  /** Delegation tokens presented by the controller, one per received dispatch. */
  tokens: string[];
  close: () => Promise<void>;
}

/**
 * @description A real loopback bot node answering POST /api/swarm-execute, recording the
 * delegation header so "this ticket crossed the signed hop" is observed rather than assumed.
 * Signature verification has its own guards (tests/unit/bot-node-delegation.spec.ts).
 * @returns The running stub, its base URL, and a close handle.
 */
async function startStubNode(): Promise<StubNode> {
  const tokens: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      tokens.push(String(req.headers['x-oshal-delegation-token'] ?? ''));
      let taskId: string | undefined;
      try { taskId = JSON.parse(body).taskId; } catch { taskId = undefined; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        response: 'stub node accepted the signed dispatch',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'spec-stub',
        provider: 'spec-stub',
        taskId,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * @description Controller signing material generated FOR THIS RUN, so the guard never reads or
 * depends on the deployment's key.
 * @returns An env map that makes BotNodeClient.isDelegationEnforced() true.
 */
function localSigningEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    OSHAL_DELEGATION_SIGNING_KID: 'spec-task-call-out-endpoint-routing',
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
  } as NodeJS.ProcessEnv;
}

/** The endpoint the controller would resolve for a bot, through the real decision function. */
function realEndpoint(agentId: string): string | null {
  return resolveBotNodeEndpoint(agentId, getActiveRegistry(), isControllerInlineContainer);
}

/** One status the dispatcher persisted for a ticket. */
interface RecordedStatus { status: string; metadata: Record<string, unknown> }

interface CallOutRun {
  recorded: RecordedStatus[];
  /** The agent the REAL call-out selected, before the dispatcher's endpoint decision. */
  callOutAgentId: string | null;
  /** The router tier that selected it — 'bid' is the live shape this entry was filed for. */
  callOutStrategy: string | null;
  tokensSent: number;
}

/**
 * @description Runs one REAL call-out and one REAL manifest-worker dispatch end to end.
 * @param options - Which bot wins the bid, which worker the workflow declares, and the signing env.
 * @returns Every status the dispatcher wrote, plus what the call-out actually decided.
 */
async function runTaskDispatch(options: {
  bidderAgentId: string;
  candidates: SpecAgent[];
  workflowWorkerBot: string;
  signingEnv: NodeJS.ProcessEnv;
  node: StubNode;
}): Promise<CallOutRun> {
  const { bidderAgentId, candidates, workflowWorkerBot, signingEnv, node } = options;
  const onlineIds = candidates.map((agent) => agent.agentId);

  const broadcaster = new MeshBidBroadcaster(
    new InMemoryMeshTransport(),
    async () => onlineIds,
    { bidWindowMs: 2_000 },
  );
  broadcaster.setMeshCommunicationService(bidderRepliesFor(bidderAgentId, 0.95));

  const callOut = buildTaskCallOutResolver({
    agentRouter: new AgentRouter(),
    meshBidBroadcaster: broadcaster,
    agentProfileRepository: specAgentRepository(candidates),
    resolveOnlineAgentIds: async () => onlineIds,
  });

  let callOutAgentId: string | null = null;
  let callOutStrategy: string | null = null;

  const workflow: WorkflowDefinition = {
    ticketType: 'task',
    name: 'Jarvis Assistant Task',
    pipeline: 'manifest-worker',
    workerBot: workflowWorkerBot,
  };

  const ticket = {
    ticketId: `00000000-0000-4000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`,
    title: 'call-out endpoint routing guard',
    description: 'Dispatched by tests/unit/task-call-out-endpoint-routing.spec.ts',
    status: 'approved',
    ticketType: 'task',
    ownerSub: SPEC_OWNER_SUB,
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://spec.invalid/issuer' },
  } as unknown as InternalTicket;

  const botNodeClient = new BotNodeClient(
    (agentId: string) => (realEndpoint(agentId) === null ? null : node.baseUrl),
    5_000,
    { env: signingEnv },
  );

  const recorded: RecordedStatus[] = [];
  const tokensBefore = node.tokens.length;

  // The queue manager runs its poll loop under runWithSystemIdentity (queue-manager-service.ts
  // seq 39); resolveDelegatedPrincipal refuses a user-bound token without that context, so the
  // guard dispatches exactly the way the running controller does.
  await runWithSystemIdentity(() => dispatchManifestWorkerTicket(ticket, workflow, {
    activeTicketIds: new Set<string>(),
    dispatchStartTimes: new Map<string, number>(),
    botNodeClient,
    resolveAgentIdByName: async (name: string) => getActiveRegistry().find((b) => b.name === name)?.agentId,
    resolveTaskWorker: async (t: InternalTicket) => {
      const result = await callOut(t);
      callOutAgentId = result?.agentId ?? null;
      callOutStrategy = result?.strategy ?? null;
      return result;
    },
    // The REAL controller stores, in their in-memory form: persistBotNodeResult refuses to
    // complete a dedicated-node dispatch without them, and its owner-binding check runs for real.
    taskStore: new InMemoryTaskStore(),
    messageStore: new InMemoryMessageStore(),
    ticketService: {
      updateStatus: async (_id: string, status: string, metadata: Record<string, unknown>) => {
        recorded.push({ status, metadata: metadata ?? {} });
      },
    } as never,
  }));

  return { recorded, callOutAgentId, callOutStrategy, tokensSent: node.tokens.length - tokensBefore };
}

/** The status the dispatcher parked the ticket at, with its metadata. */
function escalation(run: CallOutRun): RecordedStatus | undefined {
  return run.recorded.find((r) => r.status === 'escalated');
}

/** The completion the dispatcher wrote, with its route metadata. */
function completion(run: CallOutRun): RecordedStatus | undefined {
  return run.recorded.find((r) => r.status === 'complete');
}

describe('a task call-out that selects an endpoint-less owner under signed delegation', () => {
  let node: StubNode;
  let signingEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    node = await startStubNode();
    signingEnv = localSigningEnv();
  });
  afterAll(async () => { await node.close(); });
  afterEach(() => { unregisterAppBots(SPEC_APP); });

  it('has signing configured and a registry that really answers', () => {
    // Without these two facts every case below could pass vacuously.
    const client = new BotNodeClient(() => null, 1_000, { env: signingEnv });
    expect(client.isDelegationEnforced(), 'the guard must run WITH signing configured').toBe(true);
    expect(getActiveRegistry().length, 'no active registry - endpoint resolution is meaningless')
      .toBeGreaterThan(10);
  });

  it('reaches the workflow-declared worker instead of dying at the transport (unregistered bidder)', async () => {
    registerAppBots(SPEC_APP, [REACHABLE_WORKER]);
    expect(realEndpoint(UNREGISTERED_OWNER.agentId), 'the bidder must own NO endpoint').toBeNull();
    expect(realEndpoint(REACHABLE_WORKER.agentId), 'the declared worker must own one').not.toBeNull();

    const run = await runTaskDispatch({
      bidderAgentId: UNREGISTERED_OWNER.agentId,
      candidates: [UNREGISTERED_OWNER, { agentId: REACHABLE_WORKER.agentId, name: REACHABLE_WORKER.name }],
      workflowWorkerBot: REACHABLE_WORKER.name,
      signingEnv,
      node,
    });

    // The call-out really did hand the ticket to the endpoint-less owner — this is the defect.
    expect(run.callOutStrategy, 'the guard must exercise the BID tier, the live shape').toBe('bid');
    expect(run.callOutAgentId).toBe(UNREGISTERED_OWNER.agentId);

    expect(escalation(run)?.metadata.message, 'the ticket escalated with the TRANSPORT message')
      .not.toBe(INLINE_REFUSAL);
    expect(escalation(run), `the ticket escalated: ${JSON.stringify(run.recorded)}`).toBeUndefined();
    expect(completion(run)?.metadata.workerAgentId).toBe(REACHABLE_WORKER.agentId);
    expect(completion(run)?.metadata.routedBy).toBe(CALL_OUT_UNREACHABLE_ROUTED_BY);
    // And it crossed the signed boundary rather than an inline or localhost leg.
    expect(run.tokensSent).toBe(1);
    expect(node.tokens[node.tokens.length - 1].length).toBeGreaterThan(0);
  });

  it('does the same for a controller-inline bidder (the `container: oshal-api` shape)', async () => {
    registerAppBots(SPEC_APP, [REACHABLE_WORKER, INLINE_OWNER]);
    expect(realEndpoint(INLINE_OWNER.agentId), 'a controller-inline bot owns no endpoint').toBeNull();

    const run = await runTaskDispatch({
      bidderAgentId: INLINE_OWNER.agentId,
      candidates: [
        { agentId: INLINE_OWNER.agentId, name: INLINE_OWNER.name },
        { agentId: REACHABLE_WORKER.agentId, name: REACHABLE_WORKER.name },
      ],
      workflowWorkerBot: REACHABLE_WORKER.name,
      signingEnv,
      node,
    });

    expect(run.callOutAgentId).toBe(INLINE_OWNER.agentId);
    expect(escalation(run)?.metadata.message).not.toBe(INLINE_REFUSAL);
    expect(completion(run)?.metadata.workerAgentId).toBe(REACHABLE_WORKER.agentId);
    expect(completion(run)?.metadata.routedBy).toBe(CALL_OUT_UNREACHABLE_ROUTED_BY);
  });

  it('refuses by ROUTING decision, not by transport, when no reachable worker exists at all', async () => {
    registerAppBots(SPEC_APP, [INLINE_OWNER]);

    const run = await runTaskDispatch({
      bidderAgentId: UNREGISTERED_OWNER.agentId,
      candidates: [UNREGISTERED_OWNER, { agentId: INLINE_OWNER.agentId, name: INLINE_OWNER.name }],
      // The workflow's own worker is controller-inline too, so there is nowhere left to route.
      workflowWorkerBot: INLINE_OWNER.name,
      signingEnv,
      node,
    });

    const parked = escalation(run);
    expect(parked, `the ticket did not escalate: ${JSON.stringify(run.recorded)}`).toBeDefined();
    expect(parked!.metadata.reason).toBe(CALL_OUT_UNREACHABLE_REASON);
    const message = String(parked!.metadata.message);
    expect(message, 'the refusal still names the transport').not.toContain('Signed HTTP delegation');
    expect(message).toContain(UNREGISTERED_OWNER.agentId);
    expect(message).toContain(INLINE_OWNER.name);
    expect(parked!.metadata.callOutAgentId).toBe(UNREGISTERED_OWNER.agentId);
    // Still fail-closed: nothing was dispatched anywhere.
    expect(run.tokensSent).toBe(0);
  });

  it('leaves a REACHABLE call-out winner owning its ticket (no silent ownership change)', async () => {
    registerAppBots(SPEC_APP, [REACHABLE_WORKER, INLINE_OWNER]);

    const run = await runTaskDispatch({
      bidderAgentId: REACHABLE_WORKER.agentId,
      candidates: [
        { agentId: REACHABLE_WORKER.agentId, name: REACHABLE_WORKER.name },
        { agentId: INLINE_OWNER.agentId, name: INLINE_OWNER.name },
      ],
      // The workflow declares the OTHER bot, so a reroute would be visible here.
      workflowWorkerBot: INLINE_OWNER.name,
      signingEnv,
      node,
    });

    expect(run.callOutAgentId).toBe(REACHABLE_WORKER.agentId);
    expect(completion(run)?.routedBy ?? completion(run)?.metadata.routedBy).toBe('bid');
    expect(completion(run)?.metadata.workerAgentId).toBe(REACHABLE_WORKER.agentId);
    expect(run.tokensSent).toBe(1);
  });

  it('changes nothing when signing is OFF — an endpoint-less winner still owns its ticket', async () => {
    registerAppBots(SPEC_APP, [REACHABLE_WORKER, INLINE_OWNER]);

    const run = await runTaskDispatch({
      bidderAgentId: INLINE_OWNER.agentId,
      candidates: [
        { agentId: INLINE_OWNER.agentId, name: INLINE_OWNER.name },
        { agentId: REACHABLE_WORKER.agentId, name: REACHABLE_WORKER.name },
      ],
      workflowWorkerBot: REACHABLE_WORKER.name,
      // No signing material: isDelegationEnforced() is false, so the inline path is legal.
      signingEnv: {} as NodeJS.ProcessEnv,
      node,
    });

    expect(run.callOutAgentId).toBe(INLINE_OWNER.agentId);
    // The localhost leg has no server in this spec, so the dispatch fails - but it fails as the
    // BID winner, which is the fact under test: unsigned deployments are not rerouted.
    const routedBy = escalation(run)?.metadata.routedBy ?? completion(run)?.metadata.routedBy;
    expect(routedBy).toBe('bid');
    expect(escalation(run)?.metadata.workerAgentId ?? completion(run)?.metadata.workerAgentId)
      .toBe(INLINE_OWNER.agentId);
    expect(run.tokensSent).toBe(0);
  });
});
