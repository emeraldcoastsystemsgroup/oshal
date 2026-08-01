/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): the ONE constants module for triage defaults (spec §9.8 — the source platform shipped a knob whose documented default and read-site default disagreed; every triage stage reads its defaults from here)
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'alert-triage-constants' });

/**
 * @description Top-level ticket-metadata field carrying the rendered incident key (FR-C1).
 * Stored flat (not inside `metadata.incident`) because the store's metadata lookup uses the
 * JSONB `->>` top-level-key operator — `findLatestByMetadataKey(ALERT_INCIDENT_KEY_FIELD, key)`
 * is the consolidation lookup (spec §5: "the existing findActiveTicketByMetadataKey lookup
 * generalizes to the incident key").
 */
export const ALERT_INCIDENT_KEY_FIELD = 'incidentKey';

/**
 * @description Default recurrence window in seconds (FR-C5): a refire whose incident key
 * matches a ticket that went terminal within this window opens a NEW ticket linked via
 * `recurrenceOf`. 24h is the battle-tested value (spec P4 / source ADR-019 — 900s TTLs
 * re-notified all day during real duplicate storms).
 */
export const ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS = 86400;

/**
 * @description Cap on recorded incident members, with an overflow counter once exceeded.
 * FR-D5 (P2 bundling) formalizes this as ALERT_MAX_MEMBERS; the cap exists from P1 so
 * fingerprint churn (label churn on one incident key) can never grow a ticket's metadata
 * without bound.
 */
export const ALERT_MAX_INCIDENT_MEMBERS = 50;

/**
 * @description Ticket states in which an incident record is closed for consolidation: a
 * refire on a terminal ticket starts a fresh incident (optionally recurrence-linked, FR-C5)
 * instead of updating it. Everything else — backlog, approved, every in_process_* phase,
 * approval_required, customer_action, escalated, dead_letter, paused — is an OPEN incident
 * that accumulates refires (FR-C2/C3).
 */
export const TERMINAL_TICKET_STATES: ReadonlySet<string> = new Set(['complete', 'cancelled']);

/**
 * @description Resolves the consolidation TTL in seconds from `ALERT_CONSOLIDATION_TTL`,
 * falling back to the 24h default on unset/unparseable/negative values (never throws —
 * a bad knob must not take down the intake). Read at intake time, not module load, so a
 * deployment can retune it without a rebuild.
 * @returns TTL in whole seconds.
 */
export function consolidationTtlSeconds(): number {
  const raw = (process.env.ALERT_CONSOLIDATION_TTL ?? '').trim();
  if (!raw) return ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn({ raw }, 'ALERT_CONSOLIDATION_TTL is not a non-negative number — using the 24h default');
    return ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS;
  }
  return parsed;
}

/**
 * @description Answers whether a terminal ticket is still inside the recurrence window
 * (FR-C5): `now - terminalAt <= ttl`. The terminal timestamp is the ticket's `updatedAt`
 * (the status flip to complete/cancelled is the last write). Unparseable timestamps return
 * false — an undatable predecessor never manufactures a recurrence link.
 * @param terminalAtIso - ISO timestamp of the predecessor's terminal transition.
 * @param nowMs - Current epoch milliseconds (injected for deterministic guards).
 * @param ttlSeconds - Window size in seconds.
 * @returns True when the predecessor went terminal within the window.
 */
export function isWithinConsolidationTtl(terminalAtIso: string, nowMs: number, ttlSeconds: number): boolean {
  const terminalMs = Date.parse(terminalAtIso);
  if (!Number.isFinite(terminalMs)) return false;
  return (nowMs - terminalMs) / 1000 <= ttlSeconds;
}
