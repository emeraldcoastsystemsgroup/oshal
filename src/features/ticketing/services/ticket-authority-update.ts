/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep ticket owner and reserved authority metadata immutable through partial updates.
 */
import type { InternalTicket } from '@/entities/ticket';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { PROTECTED_RESULT_EXECUTIONS, stripProtectedResultMetadata } from '@/shared/protected-results';

type TicketUpdate = Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>;
/** @description Preserve server-owned identity/result authority while allowing ordinary ticket field edits.
 * @param current Durable ticket. @param updates Untrusted partial update. @returns Sanitized update.
 */
export function protectTicketAuthorityUpdate(current: InternalTicket, updates: TicketUpdate): TicketUpdate {
  if (updates.ownerSub !== undefined && updates.ownerSub !== current.ownerSub) throw new Error('ticket_owner_immutable');
  const next = { ...updates };
  if (updates.metadata !== undefined) {
    next.metadata = stripProtectedResultMetadata(updates.metadata);
    delete next.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY];
    for (const key of [OWNER_PRINCIPAL_ISSUER_METADATA_KEY, PROTECTED_RESULT_EXECUTIONS]) {
      if (Object.prototype.hasOwnProperty.call(current.metadata, key)) next.metadata[key] = current.metadata[key];
    }
  }
  return next;
}
