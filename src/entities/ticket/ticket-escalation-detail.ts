/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Derive the operator-facing escalation detail from the transition record every escalation already writes (a ticket_status_history row, mirrored onto the ticket row as metadata.lastStatusTransition) so a cockpit escalation panel can show the recorded reason without a second durable store carrying the same fact
 */

import type { TicketStatusHistoryRecord, TicketStatusMetadata } from './ticket-store';

const ESCALATED_STATUS = 'escalated';

/**
 * @description The escalation facts an operator needs, read back from the transition
 * record that `buildStatusTransitionMetadata` guarantees for every escalated ticket.
 * `origin` says which record answered so a reader can tell an append-only history row
 * from the last-transition mirror kept on the ticket row.
 */
export interface TicketEscalationDetail {
  reason: string;
  source: string;
  severity: string;
  nextAction: string;
  message: string;
  previousStatus: string;
  createdAt: string;
  origin: 'status-history' | 'ticket-metadata';
}

/**
 * @description Derives the escalation detail for a ticket from the records the
 * escalating path already wrote. The append-only status history wins; the ticket
 * row's `lastStatusTransition` mirror is the fallback for callers that cannot read
 * history. Returns null when no record carries a reason, so a caller can say
 * "nothing was recorded" honestly instead of rendering an empty explanation.
 * @param history - Status history rows for the ticket, in any order.
 * @param ticketMetadata - The ticket row's metadata object, if available.
 * @returns The recorded escalation detail, or null when no reason was recorded.
 */
export function deriveTicketEscalationDetail(
  history: readonly TicketStatusHistoryRecord[] | null | undefined,
  ticketMetadata: TicketStatusMetadata | null | undefined,
): TicketEscalationDetail | null {
  const historyRow = selectLatestEscalationRow(history);
  const fromHistory = historyRow
    ? buildDetail(historyRow.metadata, 'status-history', readText(historyRow.createdAt))
    : null;
  if (fromHistory) {
    return fromHistory;
  }

  return buildDetail(readLastStatusTransition(ticketMetadata), 'ticket-metadata', '');
}

/**
 * @description Picks the newest row whose transition landed on `escalated`.
 * @param history - Status history rows in any order.
 * @returns The newest escalating row, or null when there is none.
 */
function selectLatestEscalationRow(
  history: readonly TicketStatusHistoryRecord[] | null | undefined,
): TicketStatusHistoryRecord | null {
  if (!Array.isArray(history)) {
    return null;
  }

  return history.reduce<TicketStatusHistoryRecord | null>((latest, row) => {
    if (readText(row?.toStatus) !== ESCALATED_STATUS) {
      return latest;
    }
    if (!latest) {
      return row;
    }
    return timestampOf(row.createdAt) >= timestampOf(latest.createdAt) ? row : latest;
  }, null);
}

/**
 * @description Reads the ticket row's mirror of the last status transition when that
 * transition was an escalation.
 * @param ticketMetadata - The ticket row's metadata object.
 * @returns The mirrored transition metadata, or null.
 */
function readLastStatusTransition(
  ticketMetadata: TicketStatusMetadata | null | undefined,
): TicketStatusMetadata | null {
  const transition = readRecord(ticketMetadata)?.lastStatusTransition;
  const record = readRecord(transition);
  if (!record || readText(record.status) !== ESCALATED_STATUS) {
    return null;
  }
  return record;
}

/**
 * @description Shapes one transition metadata object into the operator-facing detail.
 * @param metadata - Recorded transition metadata.
 * @param origin - Which record the metadata came from.
 * @param createdAt - Row timestamp, when the record has one.
 * @returns The detail, or null when the metadata carries no reason.
 */
function buildDetail(
  metadata: TicketStatusMetadata | null | undefined,
  origin: TicketEscalationDetail['origin'],
  createdAt: string,
): TicketEscalationDetail | null {
  const record = readRecord(metadata);
  const reason = readText(record?.reason);
  if (!record || !reason) {
    return null;
  }

  return {
    reason,
    source: readText(record.source),
    severity: readText(record.severity),
    nextAction: readText(record.nextAction),
    message: readText(record.message),
    previousStatus: readText(record.previousStatus),
    createdAt: createdAt || readText(record.escalatedAt),
    origin,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function timestampOf(value: unknown): number {
  const parsed = Date.parse(readText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
