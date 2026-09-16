/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Mirror the last status transition onto the ticket row (plus the board fields operator lists read) without overwriting queue/app provenance such as metadata.source = "jarvis"
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Always mirror the transition that actually happened. Returning null for a transition that carried no metadata left the mirror describing the PREVIOUS transition, so a ticket de-escalated with no metadata - what the cockpit status route sends - kept an 'escalated' mirror after leaving 'escalated', and deriveTicketEscalationDetail read that finished escalation back as the current one.
 */

import type { TicketStatusMetadata } from './ticket-store';
import type { OshalTicketState } from './types';

/**
 * @description Builds the small ticket-row metadata patch that keeps operator boards
 * useful without overwriting queue/app provenance such as metadata.source = "jarvis".
 * `lastStatusTransition` always describes the transition being written, including one
 * that carried no metadata: it is the mirror `deriveTicketEscalationDetail` falls back
 * to, so leaving a finished escalation in place there would report an escalation the
 * ticket is no longer in. The board fields below are written only when the transition
 * actually carried them, which is what keeps this patch from blanking provenance.
 * @param status - The status the ticket is moving to.
 * @param metadata - The transition metadata, which may be empty.
 * @returns The metadata patch to merge onto the ticket row.
 */
export function buildTicketRowStatusMetadataPatch(
  status: OshalTicketState,
  metadata: TicketStatusMetadata,
): Record<string, unknown> {
  const source = readText(metadata, 'source');
  const reason = readText(metadata, 'reason') ?? readText(metadata, 'message');
  const severity = readText(metadata, 'severity');
  const nextAction = readText(metadata, 'nextAction');
  const failureClass = readText(metadata, 'failureClass');
  const transition = { status, ...metadata };
  const patch: Record<string, unknown> = {
    lastStatusTransition: transition,
  };

  if (reason) patch.reason = reason;
  if (source) patch.statusSource = source;
  if (severity) patch.severity = severity;
  if (nextAction) patch.nextAction = nextAction;
  if (failureClass) patch.failureClass = failureClass;

  return patch;
}

function readText(metadata: TicketStatusMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
