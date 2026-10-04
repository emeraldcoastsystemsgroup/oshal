/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dispatch-time ticket gates, extracted from dispatch-manifest-worker.ts (past the 800-code-line stop) so the worker shrinks while gaining a gate. (1) The ADR-081 privileged-type gate, moved with its escalation reason, message and next action unchanged. (2) Plan Z-08: a metadata.targetAgentId pin is authorized against the ticket owner's CURRENT rights with the same direct entitlement the ticket door applies, before it can outrank the call-out. Only a strictly parsed provider intent, whose fixed provider agent overrides the pin, skips that check. An absent owner is internal work. When the check cannot decide, the pin is refused under a truthful reason, never an entitlement verdict, and logged as a structured error: an invalid owner subject is pinned_ticket_owner_invalid, and any other fault is pin_authorization_unavailable. Nothing is rethrown, because the queue dispatches fire-and-forget.
 */
import { decideExecuteEntitlement } from '@/app/bot-node-execute-entitlement';
import { createChildLogger } from '@/shared/logger';
import { isPrivilegedTicketType, isSuperAdminSub } from '@/shared/middleware/superadmin';
import { InvalidUserSubjectError } from '@/shared/security/exact-user-subject';

const logger = createChildLogger({ module: 'dispatch-ticket-gates' });

/**
 * @description A terminal dispatch refusal. `escalation` is written verbatim as the ticket's escalated status
 * detail, and the ticket is never claimed, so a refused ticket cannot re-dispatch every poll. `logMessage` is
 * the worker's warning text, kept out of the stored detail.
 */
export interface DispatchGateRefusal {
  escalation: { reason: string; source: 'dispatch-manifest-worker'; message: string; nextAction: string };
  logMessage: string;
}

/**
 * @description The facts the gates read. `providerAgentId` must come only from a strictly parsed provider intent
 * (trustedProviderAgentId), never from caller metadata.
 */
export interface DispatchGateInput {
  ticketType: string;
  ownerSub: string | null | undefined;
  pinnedAgentId?: string;
  providerAgentId?: string;
}

/**
 * @description ADR-081: a privileged ticket type reaches its bot only when the OWNER is an allowlisted super-admin.
 * @param input - The dispatch facts.
 * @returns The unchanged superadmin_required refusal, or null.
 */
function refusePrivilegedType(input: DispatchGateInput): DispatchGateRefusal | null {
  if (!isPrivilegedTicketType(input.ticketType) || isSuperAdminSub(input.ownerSub)) return null;
  return {
    escalation: {
      reason: 'superadmin_required',
      source: 'dispatch-manifest-worker',
      message: `ticketType '${input.ticketType}' is privileged: the ticket owner must be on OSHAL_SUPERADMIN_SUBS`,
      nextAction: 'file_as_superadmin_or_update_allowlist',
    },
    logMessage: 'Privileged ticketType denied — owner is not on the super-admin allowlist',
  };
}

/**
 * @description A pin refusal with the dispatcher's terminal escalation shape.
 * @param reason - Machine reason. @param message - Human explanation. @param nextAction - What unblocks it.
 * @param logMessage - The worker's warning text.
 * @returns The refusal.
 */
function pinRefusal(reason: string, message: string, nextAction: string, logMessage: string): DispatchGateRefusal {
  return { escalation: { reason, source: 'dispatch-manifest-worker', message, nextAction }, logMessage };
}

/**
 * @description A pin whose authorization could not be decided is refused (fail closed) under a truthful reason, and
 * never as an entitlement verdict. An invalid owner subject (InvalidUserSubjectError) is the ticket's own defect;
 * anything else is an infrastructure fault. Both are logged as structured errors. The queue calls the dispatcher
 * fire-and-forget, so rethrowing would become an unhandled rejection.
 * @param input - The dispatch facts. @param error - What the entitlement check threw.
 * @returns The refusal for that cause.
 */
function refuseUndecidablePin(input: DispatchGateInput, error: unknown): DispatchGateRefusal {
  const invalidOwner = error instanceof InvalidUserSubjectError;
  logger.error({ err: error, ticketType: input.ticketType, pinnedAgentId: input.pinnedAgentId, invalidOwner },
    invalidOwner ? 'Pinned dispatch refused: the ticket owner is not a valid exact user subject'
      : 'Pinned dispatch refused: pin authorization could not be decided');
  return invalidOwner
    ? pinRefusal('pinned_ticket_owner_invalid', `the ticket pins agent '${input.pinnedAgentId}' but its owner subject is not valid`,
      'refile_with_a_valid_owner', 'Pinned agent refused at dispatch — the ticket owner subject is invalid')
    : pinRefusal('pin_authorization_unavailable', `the pin to agent '${input.pinnedAgentId}' could not be authorized`,
      'operator_review_required', 'Pinned agent refused at dispatch — authorization could not be decided');
}

/**
 * @description Z-08: a pin is the filer's explicit choice of bot, so it must pass the direct entitlement the owner
 * has NOW (operator, a Jarvis-accessible bot, or the assistant front door). The swarm's own choices (call-out,
 * workflow default) stay trusted and are not checked here.
 * @param input - The dispatch facts.
 * @returns A refusal (not entitled, invalid owner, or undecidable), or null.
 */
function refuseUnentitledPin(input: DispatchGateInput): DispatchGateRefusal | null {
  if (!input.pinnedAgentId || input.providerAgentId) return null;
  let allowed: boolean;
  try {
    allowed = decideExecuteEntitlement({ userSub: input.ownerSub, direct: true, targetAgentId: input.pinnedAgentId }).allowed;
  } catch (error) {
    return refuseUndecidablePin(input, error);
  }
  return allowed ? null : pinRefusal('pinned_agent_not_entitled',
    `the ticket pins agent '${input.pinnedAgentId}', which its owner may not call directly`,
    'refile_without_pin_or_as_operator', 'Pinned agent refused at dispatch — the ticket owner may not call it directly');
}

/**
 * @description Run the dispatch-time ticket gates in order: privileged type, then pin authorization.
 * @param input - The dispatch facts.
 * @returns The first refusal, or null when the ticket may dispatch.
 */
export function refuseTicketAtDispatch(input: DispatchGateInput): DispatchGateRefusal | null {
  return refusePrivilegedType(input) ?? refuseUnentitledPin(input);
}
