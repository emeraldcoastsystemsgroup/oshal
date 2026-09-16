/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ADR-083 call-out's endpoint decision, extracted so it is testable on its own and so dispatch-manifest-worker.ts does not grow past the file-size gate. Closes BACKLOG "The `task` call-out can still hand a ticket to a controller-inline bot under signing": a bid won by an owner with no dedicated bot-node endpoint is not ownership under signed delegation, it is a ticket that dies at the transport, so the winner is set aside for the workflow's declared worker and — if that one is unreachable too — the refusal names the ROUTING decision instead of the HTTP hop.
 */

import type { TaskCallOutOwner } from './task-call-out';

/**
 * `routedBy` recorded when a call-out winner was set aside for the workflow's declared
 * worker. Distinct from plain `workflow-default` on purpose: the ticket's routing metadata
 * has to say that an owner DID claim it and was overruled by reachability, not that the
 * call-out never ran.
 */
export const CALL_OUT_UNREACHABLE_ROUTED_BY = 'workflow-default-call-out-unreachable';

/** Escalation `reason` for a call-out the controller cannot route anywhere reachable. */
export const CALL_OUT_UNREACHABLE_REASON = 'call_out_worker_has_no_dedicated_endpoint';

/** The owner a call-out round selected, as the dispatcher holds it. */
export interface CallOutWinner {
  agentId: string;
  agentName: string | null;
}

/**
 * @description The two questions this decision asks of the bot-node client: is signed
 * delegation mandatory, and does this agent own a dedicated node. Declared structurally so
 * this module does not import the agent-management slice (FSD: no cross-slice imports at a
 * layer) — `BotNodeClient` satisfies it as-is.
 */
export interface DelegationEndpointPosture {
  isDelegationEnforced(): boolean;
  hasEndpoint(agentId: string): boolean;
}

/**
 * @description Decides whether an ADR-083 call-out winner must be set aside because signed
 * delegation cannot reach it.
 *
 * WHY THIS EXISTS. With controller signing configured, a worker that resolves to no
 * bot-node endpoint cannot be dispatched at all — there is no network hop for the token to
 * bind to, and `dispatchManifestWorkerTicket` refuses it with a message about HTTP
 * transport. The `task` lane is open by call-out, so the winner can be a controller-inline
 * bot, a bot the codex rule holds inline, or an online agent with no registry definition at
 * all (a live heartbeat is enough to bid). In every one of those cases the bid was never
 * ownership: the ticket was always going to park in `escalated`. Handing it to the
 * workflow's DECLARED worker — which the workflow names precisely because it is
 * dispatchable — takes nothing away from the winner and is the same fallback ADR-083 §5
 * already applies when no owner claims a task at all.
 *
 * WHAT THIS DOES NOT DO. It never lets an unsigned or unverifiable dispatch through. The
 * chosen worker still crosses the signed boundary, and when no reachable worker exists the
 * ticket is still refused — only the stated reason changes, from the transport to the
 * routing decision that produced it.
 *
 * Only active under enforcement: with signing off, an endpoint-less winner runs inline
 * today and keeps doing so, so no deployment silently changes owners.
 *
 * @param winner - The call-out selection, or null when the call-out chose nobody.
 * @param posture - The bot-node client, or undefined when the controller has none wired.
 * @returns The winner to set aside, or null to keep the call-out result as-is.
 */
export function unreachableCallOutWinner(
  winner: CallOutWinner | null,
  posture: DelegationEndpointPosture | undefined,
): CallOutWinner | null {
  if (!winner || !posture) return null;
  try {
    if (!posture.isDelegationEnforced()) return null;
    if (posture.hasEndpoint(winner.agentId)) return null;
  } catch {
    // Reachability could not be determined (registry loader cold). Keep the call-out result:
    // the dispatcher's own endpoint branch still fails closed, which is the pre-existing
    // behavior. Never the other way round — an unknown endpoint is not a licence to reroute.
    return null;
  }
  return winner;
}

/**
 * @description Builds the escalation metadata for a `task` ticket whose call-out winner had
 * no dedicated endpoint AND whose workflow-declared worker has none either. The message
 * names the routing decision and both bots involved, so the ticket says what to change
 * without a log dig — the transport message it replaces said only that HTTP delegation
 * needs an endpoint, which is true of every refusal and identifies none of them.
 * @param setAside - The call-out winner that could not be reached.
 * @param workflowWorkerBot - The workflow's declared worker, which was tried next.
 * @param routing - The dispatcher's route metadata object, recorded alongside the reason.
 * @returns Status metadata for `ticketService.updateStatus(ticketId, 'escalated', ...)`.
 */
export function callOutUnreachableEscalation(
  setAside: CallOutWinner,
  workflowWorkerBot: string,
  routing: object,
): Record<string, unknown> {
  const owner = setAside.agentName ?? setAside.agentId;
  return {
    reason: CALL_OUT_UNREACHABLE_REASON,
    source: 'dispatch-manifest-worker',
    ...routing,
    callOutAgentId: setAside.agentId,
    ...(setAside.agentName ? { callOutAgentName: setAside.agentName } : {}),
    message: `The task call-out selected ${owner} (${setAside.agentId}), which owns no dedicated `
      + `bot-node endpoint, and the workflow-declared worker ${workflowWorkerBot} owns none either, `
      + 'so signed delegation has no node to route this ticket to',
    nextAction: 'give_the_selected_owner_a_dedicated_bot_node_or_declare_a_reachable_workflow_worker',
  };
}

/**
 * @description Trims a bot label to one safe single-line token for prompt/metadata text.
 * @param value - The registry/persona name as the resolver reported it.
 * @returns The same name with newlines flattened and length bounded.
 */
export function safeWorkerLabel(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

/**
 * @description Validates the bounded multi-owner fan-out set a call-out reported, rejecting
 * malformed resolver output instead of widening the contract the dispatcher honours.
 * @param owners - Near-lead owners from the call-out, lead first.
 * @param winnerAgentId - The single winner the set must lead with.
 * @returns The validated owners, or an empty array when the set is not usable.
 */
export function validatedFanOutOwners(
  owners: TaskCallOutOwner[] | undefined,
  winnerAgentId: string,
): TaskCallOutOwner[] {
  // Defense in depth: reject malformed resolver output instead of widening the bounded contract.
  if (!owners || owners.length < 2 || owners.length > 3) return [];
  if (owners[0]?.agentId !== winnerAgentId) return [];
  const leadConfidence = owners[0]?.confidence;
  if (!Number.isFinite(leadConfidence) || leadConfidence < 0.5) return [];

  const seen = new Set<string>();
  const validated: TaskCallOutOwner[] = [];
  for (const owner of owners) {
    const agentId = typeof owner.agentId === 'string' ? owner.agentId.trim() : '';
    const agentName = typeof owner.agentName === 'string' ? safeWorkerLabel(owner.agentName) : '';
    if (!agentId || !agentName || seen.has(agentId)) return [];
    if (!Number.isFinite(owner.confidence)
      || owner.confidence < 0.5
      || leadConfidence - owner.confidence > 0.15 + Number.EPSILON) return [];
    seen.add(agentId);
    validated.push({ agentId, agentName, confidence: owner.confidence });
  }
  return validated;
}
