/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Expose a bounded registry-backed list of near-lead qualified bid owners for safe mixed-domain fan-out.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-083 knowledge-owner call-out for the generic 'task' lane: broadcast a BID_REQUEST to online owners (they self-score), decide via the AgentRouter cascade (bid → LLM → keyword → score), and report whether a REAL owner claimed the ticket. Replaces the deleted free-text resolveTaskBotAgentId regex in jarvis-routes; the queue manager now engages on every task instead of trusting a keyword guess.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-087: jarvis-sourced tickets (metadata.source==='jarvis') are role-gated — the injected isAgentAccessibleTo checker (wired from the bot registry at composition, keeping FSD layering) drops candidates whose accessRoles exclude 'jarvis' AND adds them to the BID_REQUEST exclusion list so scoped bots never even see the broadcast. Non-jarvis tickets are unaffected.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | fix(a2a): review finding (CRITICAL) — the ADR-087 role gate only fired for metadata.source==='jarvis', so an inbound A2A ticket (a2a-rpc-service.ts stamps metadata.source:'a2a-gateway') skipped isAgentAccessibleTo entirely: every operator/swarm-scoped bot (trading, ambient-analyst, agent-factory, drone/sat-operator, task-manager, quality-judge, identity/vault, ...) stayed a live call-out candidate for a low-trust external credential holder. a2a-gateway tickets now resolve the SAME 'jarvis' caller role the A2A agent-card curator already gates discovery on (a2a-routes.ts's default isAccessible is isBotAccessibleTo(id,'jarvis')), so anything hidden from the public agent card is now also unreachable via dispatch — discovery and execution can no longer drift apart.
 */

import type { SwarmAccessRole } from '@/shared/types';
import type { InternalTicket } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type {
  AgentBid,
  AgentRouter,
  MeshBidBroadcaster,
  RouteCandidate,
} from '@/features/agent-management';
import type { AgentProfileRepository } from '@/entities/agent';
import { normalizeCandidates, type SwarmOnlineAgentIdsResolver } from './swarm-ticket-processing-support';

const logger = createChildLogger({ module: 'task-call-out' });

/** Agents that must NEVER win a generic task call-out, no matter how they score:
 *  the PM (a planner, not a doer), the Jarvis brain (conversational front door),
 *  and the platform-developer (privileged — reachable ONLY via the superadmin-gated
 *  'oshal-dev' ticketType, never because a URL happens to contain "oshal"). */
const CALL_OUT_EXCLUDED_AGENT_IDS: ReadonlySet<string> = new Set([
  'a0000000-0000-0000-0000-000000000001', // project-manager
  'a0000000-0000-0000-0000-000000000050', // oshal-assistant (Jarvis brain)
  'de000000-0000-0000-0000-000000000001', // oshal-developer (ADR-081 privileged)
  'f0000000-0000-0000-0000-000000000001', // queue-bot (reviewer, not an owner)
]);

/** The general fallback owner (ADR-083 §5) — a tool-capable doer, never the PM. */
export const GENERAL_FALLBACK_AGENT_ID = 'a0000000-0000-0000-0000-000000000099';

/**
 * Ticket sources treated as an external-ish caller for the ADR-087 role gate. Both are
 * scoped to the 'jarvis' caller role: Jarvis IS the assistant acting on a user's behalf,
 * and a2a-gateway (BACKLOG Plan F) is a low-trust EXTERNAL agent — there is no dedicated
 * SwarmAccessRole for it, so it reuses the exact predicate the A2A agent-card curator
 * already gates discovery on (isBotAccessibleTo(id, 'jarvis'), a2a-routes.ts's default).
 * Anything a bot scopes OUT of 'jarvis' (accessRoles ['operator','swarm'] with no
 * 'jarvis') must also be unreachable by external A2A dispatch.
 */
const ROLE_GATED_TICKET_SOURCES: ReadonlySet<string> = new Set(['jarvis', 'a2a-gateway']);

/** Router strategies that mean a knowledge owner actually CLAIMED the ticket
 *  (vs. the score/catch-all tiers, which just pick the least-bad candidate). */
const CONFIDENT_STRATEGIES: ReadonlySet<string> = new Set(['bid', 'llm', 'keyword']);
// Mirrors AgentRouter's Tier-1 qualification boundary; owners below it never enter fan-out metadata.
const BID_CONFIDENCE_THRESHOLD = 0.5;
const MULTI_OWNER_MAX_LEAD_GAP = 0.15;
const MAX_MULTI_OWNER_COUNT = 3;

/** A registry-backed owner whose qualified bid is close enough to the lead for bounded fan-out. */
export interface TaskCallOutOwner {
  agentId: string;
  agentName: string;
  confidence: number;
}

function rankedBidOwners(
  bids: AgentBid[],
  candidates: RouteCandidate[],
): TaskCallOutOwner[] {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
  const bestBidByAgent = new Map<string, AgentBid>();

  for (const bid of bids) {
    if (!Number.isFinite(bid.confidence) || bid.confidence < BID_CONFIDENCE_THRESHOLD) continue;
    const candidate = candidatesById.get(bid.agentId);
    if (!candidate?.name?.trim()) continue;
    const existing = bestBidByAgent.get(bid.agentId);
    if (!existing
      || bid.confidence > existing.confidence
      || (bid.confidence === existing.confidence && bid.estimatedCost < existing.estimatedCost)
      || (bid.confidence === existing.confidence
        && bid.estimatedCost === existing.estimatedCost
        && bid.estimatedLatencyMs < existing.estimatedLatencyMs)) {
      bestBidByAgent.set(bid.agentId, bid);
    }
  }

  const ranked = [...bestBidByAgent.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.estimatedCost !== b.estimatedCost) return a.estimatedCost - b.estimatedCost;
    return a.estimatedLatencyMs - b.estimatedLatencyMs;
  });
  const leadConfidence = ranked[0]?.confidence;
  if (leadConfidence === undefined) return [];

  return ranked
    .filter((bid) => (
      leadConfidence - bid.confidence <= MULTI_OWNER_MAX_LEAD_GAP + Number.EPSILON
    ))
    .slice(0, MAX_MULTI_OWNER_COUNT)
    .map((bid) => ({
      agentId: bid.agentId,
      agentName: candidatesById.get(bid.agentId)!.name!.trim(),
      confidence: bid.confidence,
    }));
}

/**
 * @description Outcome of one call-out round for a task ticket.
 */
export interface TaskCallOutResult {
  /** The agent that should own the ticket (winner, or the general fallback). */
  agentId: string;
  /** Registry/persona name for the selected agent, when declared by the candidate. */
  agentName?: string;
  /** Qualified near-lead BID owners only; absent for non-bid routing strategies. */
  owners?: TaskCallOutOwner[];
  /** Which tier decided: 'bid' | 'llm' | 'keyword' | 'score' | 'fallback-general'. */
  strategy: string;
  /** True when a knowledge owner CLAIMED the ticket (bid/llm/keyword tiers) —
   *  false means no owner wanted it and the queue manager should consider
   *  promoting to the build lane (complex) or the general fallback (simple). */
  confident: boolean;
}

/** @description Resolver signature the queue manager's task dispatch calls. */
export type TaskCallOutResolver = (ticket: InternalTicket) => Promise<TaskCallOutResult | null>;

/**
 * @description Dependencies for the call-out: the mesh bid broadcaster (owners
 * self-score a BID_REQUEST), the AgentRouter cascade, and the candidate sources.
 */
export interface TaskCallOutDeps {
  agentRouter: AgentRouter;
  meshBidBroadcaster?: MeshBidBroadcaster;
  agentProfileRepository?: AgentProfileRepository;
  resolveOnlineAgentIds?: SwarmOnlineAgentIdsResolver;
  /** ADR-087: caller-role gate, injected from the bot registry at composition
   *  (this feature slice must not import the app-layer registry). When set,
   *  jarvis-sourced AND a2a-gateway-sourced tickets (see ROLE_GATED_TICKET_SOURCES)
   *  only reach bots accessible to the 'jarvis' role. */
  isAgentAccessibleTo?: (agentId: string, role: SwarmAccessRole) => boolean;
}

/**
 * @description Builds the ADR-083 call-out resolver for the generic 'task' lane.
 * One round: normalize ONLINE candidates (registered owners with their declared
 * capabilities/keywords/selectors) → broadcast a BID_REQUEST so owners self-score →
 * decide via the AgentRouter cascade. Never throws — a failed call-out returns null
 * so the dispatcher falls back to the workflow's declared workerBot.
 * @param deps - Router, broadcaster, and candidate sources.
 * @returns The resolver the queue manager's manifest-worker dispatch consumes.
 */
export function buildTaskCallOutResolver(deps: TaskCallOutDeps): TaskCallOutResolver {
  return async (ticket: InternalTicket): Promise<TaskCallOutResult | null> => {
    const { ticketId, title, description } = ticket;
    try {
      const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
      // ADR-087: a ticket Jarvis filed (or an inbound A2A delegation — see
      // ROLE_GATED_TICKET_SOURCES above) is a caller that only role-accessible bots may own.
      const callerRole: SwarmAccessRole | null = typeof meta.source === 'string'
        && ROLE_GATED_TICKET_SOURCES.has(meta.source)
        ? 'jarvis'
        : null;

      const allCandidates = await normalizeCandidates(
        undefined, undefined, title ?? '', deps.agentProfileRepository, deps.resolveOnlineAgentIds,
      );
      let candidates = allCandidates.filter((c) => !CALL_OUT_EXCLUDED_AGENT_IDS.has(c.agentId));
      const roleBlocked: string[] = callerRole && deps.isAgentAccessibleTo
        ? candidates.filter((c) => !deps.isAgentAccessibleTo!(c.agentId, callerRole)).map((c) => c.agentId)
        : [];
      if (roleBlocked.length > 0) {
        candidates = candidates.filter((c) => !roleBlocked.includes(c.agentId));
        logger.info({ ticketId, callerRole, roleBlocked }, 'Call-out: role-scoped bots removed from candidates (ADR-087)');
      }
      if (candidates.length === 0) {
        logger.warn({ ticketId }, 'Call-out: no online candidates — falling back to workflow default');
        return null;
      }

      // CALL OUT: every online owner receives the BID_REQUEST and self-scores from its
      // DECLARED capabilities + selector. Complexity is a hint only (the persona sets it).
      // Role-blocked bots are excluded from the broadcast too — they never see the request.
      const complexity = typeof meta.complexity === 'string' ? meta.complexity : 'simple';
      const broadcast = deps.meshBidBroadcaster
        ? await deps.meshBidBroadcaster.broadcastBidRequest(
            ticketId, title ?? '', description ?? '', [], complexity, 'TASK',
            [...CALL_OUT_EXCLUDED_AGENT_IDS, ...roleBlocked],
          )
        : null;
      const bids = deps.meshBidBroadcaster?.toBids(broadcast) ?? [];

      // DECIDE: the queue manager's cascade — bid auction → LLM → keyword → score.
      const decision = await deps.agentRouter.route(
        {
          taskId: ticketId,
          ticketTitle: title ?? '',
          taskText: (description ?? '').slice(0, 1500),
          requiredCapabilities: [],
          bids,
        },
        candidates,
      );

      const claimed = CONFIDENT_STRATEGIES.has(decision.strategy)
        && !CALL_OUT_EXCLUDED_AGENT_IDS.has(decision.winner.agentId);
      if (claimed) {
        const agentName = decision.winner.name
          ?? candidates.find((candidate) => candidate.agentId === decision.winner.agentId)?.name;
        const owners = decision.strategy === 'bid' ? rankedBidOwners(bids, candidates) : [];
        logger.info(
          {
            ticketId,
            agentId: decision.winner.agentId,
            agentName,
            strategy: decision.strategy,
            bidCount: bids.length,
            candidates: candidates.length,
          },
          'Call-out: a knowledge owner claimed the task',
        );
        return {
          agentId: decision.winner.agentId,
          agentName,
          ...(owners.length > 0 ? { owners } : {}),
          strategy: decision.strategy,
          confident: true,
        };
      }

      // No owner claimed it — offer the general fallback owner if it is online.
      const general = candidates.find((c) => c.agentId === GENERAL_FALLBACK_AGENT_ID);
      if (general) {
        logger.info(
          { ticketId, strategy: decision.strategy, bidCount: bids.length },
          'Call-out: no owner claimed the task — routing to the general fallback owner',
        );
        return {
          agentId: GENERAL_FALLBACK_AGENT_ID,
          agentName: general.name,
          strategy: 'fallback-general',
          confident: false,
        };
      }

      logger.warn(
        { ticketId, strategy: decision.strategy },
        'Call-out: no owner claimed the task and the general fallback is offline — workflow default applies',
      );
      return null;
    } catch (err) {
      logger.error({ err, ticketId }, 'Call-out failed — falling back to workflow default');
      return null;
    }
  };
}
