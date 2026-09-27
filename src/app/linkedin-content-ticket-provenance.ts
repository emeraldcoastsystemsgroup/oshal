/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Write LinkedIn queue provenance back onto the originating ticket: the draft id and its citations when the queue worker persists the draft, and the publish outcome (status, post id, audited params hash) when the owner publishes it. Only the owner's own linkedin-content-post ticket is written, and ticket metadata is merged, never replaced.
 */

import type { TicketService } from '@/features/ticketing';
import type { PublishOutcome, PublishOutcomeRecorder, SocialContentDraft } from '@/features/linkedin-assistant';

/** @description The ticket type the Social manifest registers for queued LinkedIn posts. */
export const LINKEDIN_CONTENT_QUEUE_WORKFLOW = 'linkedin-content-post';

/** @description The ticket metadata key that holds the draft/publish provenance. */
export const LINKEDIN_TICKET_PROVENANCE_KEY = 'linkedinContent';

/** @description The ticket operations the write-back needs, so a caller can pass the real service. */
export type LinkedInTicketWriter = Pick<TicketService, 'getTicket' | 'updateTicket'>;

/** @description How one publish attempt ended, as recorded on the source ticket. */
export interface LinkedInTicketPublishRecord {
  /** `published` = live post; `skipped` = clean non-failure (e.g. not connected); `failed` = refused or errored. */
  status: 'published' | 'skipped' | 'failed';
  /** The LinkedIn post id when published. */
  postId: string | null;
  /** The connector params hash; joins connector_action_audit.params_hash for this owner. */
  paramsHash: string | null;
  /** The user-visible reason for a skip or failure. */
  message: string | null;
  /** When the outcome was recorded (ISO). */
  at: string;
}

/** @description The provenance a queue ticket carries under {@link LINKEDIN_TICKET_PROVENANCE_KEY}. */
export interface LinkedInTicketProvenance {
  /** The owner-scoped draft the queue worker created from this ticket. */
  draftId: number;
  /** The citations stored with that draft. */
  sourceCitations: string[];
  /** The latest publish attempt, once the owner published the draft. */
  publish?: LinkedInTicketPublishRecord;
}

/**
 * @description Classify a publish outcome for the ticket record.
 * @param outcome - What the publisher returned.
 * @returns The ticket-facing status.
 */
function publishStatus(outcome: PublishOutcome): LinkedInTicketPublishRecord['status'] {
  if (outcome.ok) return 'published';
  return outcome.skipped ? 'skipped' : 'failed';
}

/**
 * @description Merge a provenance update into the owner's own queue ticket. Refuses a ticket that
 * is missing, owned by someone else, or of another type, so a draft can never write onto a ticket
 * it did not come from.
 * @param tickets - Ticket reader/writer.
 * @param ticketId - The draft's source ticket.
 * @param ownerSub - The draft owner.
 * @param next - Builds the new provenance from the current one (undefined when none yet).
 * @returns Resolves once the merged metadata is written.
 */
async function mergeProvenance(
  tickets: LinkedInTicketWriter,
  ticketId: string,
  ownerSub: string,
  next: (current: LinkedInTicketProvenance | undefined) => LinkedInTicketProvenance,
): Promise<void> {
  const ticket = await tickets.getTicket(ticketId);
  if (!ticket || ticket.ownerSub !== ownerSub || ticket.ticketType !== LINKEDIN_CONTENT_QUEUE_WORKFLOW) {
    throw new Error('LinkedIn provenance refused: the source ticket is not this owner\'s linkedin-content-post ticket');
  }
  const metadata: Record<string, unknown> = { ...(ticket.metadata ?? {}) };
  const current = metadata[LINKEDIN_TICKET_PROVENANCE_KEY];
  metadata[LINKEDIN_TICKET_PROVENANCE_KEY] = next(
    current && typeof current === 'object' && !Array.isArray(current) ? current as LinkedInTicketProvenance : undefined,
  );
  await tickets.updateTicket(ticketId, { metadata });
}

/**
 * @description Record on the queue ticket which draft it produced. Idempotent: a retried dispatch
 * writes the same draft id again and keeps any publish record already present.
 * @param tickets - Ticket reader/writer.
 * @param ticketId - The queue ticket.
 * @param ownerSub - The ticket and draft owner.
 * @param draft - The persisted draft.
 * @returns Resolves once written; throws when the ticket is not the owner's queue ticket.
 */
export async function recordQueueDraftOnTicket(
  tickets: LinkedInTicketWriter,
  ticketId: string,
  ownerSub: string,
  draft: SocialContentDraft,
): Promise<void> {
  await mergeProvenance(tickets, ticketId, ownerSub, (current) => ({
    ...(current ?? {}),
    draftId: draft.id,
    sourceCitations: [...draft.sourceCitations],
  }));
}

/**
 * @description Build the recorder the LinkedIn assistant calls after a publish attempt on a
 * queue-created draft. It writes status, post id, params hash and reason onto the source ticket.
 * @param tickets - Ticket reader/writer.
 * @returns A {@link PublishOutcomeRecorder}.
 */
export function createTicketPublishRecorder(tickets: LinkedInTicketWriter): PublishOutcomeRecorder {
  return async (userSub, draft, outcome) => {
    if (!draft.sourceTicketId) return;
    const publish: LinkedInTicketPublishRecord = {
      status: publishStatus(outcome),
      postId: outcome.ok ? outcome.postId ?? null : null,
      paramsHash: outcome.paramsHash ?? draft.publishParamsHash ?? null,
      message: outcome.ok ? null : outcome.message ?? null,
      at: new Date().toISOString(),
    };
    await mergeProvenance(tickets, draft.sourceTicketId, userSub, (current) => ({
      draftId: draft.id,
      sourceCitations: current?.sourceCitations ?? [...draft.sourceCitations],
      publish,
    }));
  };
}
