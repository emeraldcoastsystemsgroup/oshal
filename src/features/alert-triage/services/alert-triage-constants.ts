/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): the ONE constants module for triage defaults (spec §9.8 — the source platform shipped a knob whose documented default and read-site default disagreed; every triage stage reads its defaults from here)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): the bundling knobs — ALERT_CORRELATION_WINDOW (FR-D1, default 15m), ALERT_CORRELATION_DEPTH (FR-D3, default 3 — the depth the source platform actually deployed), ALERT_MAX_MEMBERS (FR-D5 — the P1 member cap becomes the spec's configurable knob), the correlation-window predicate, and the bundle-candidate listing bound. All read at intake time with fail-safe fallbacks via one shared parser
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

/**
 * @description Default Stage D correlation window in seconds (FR-D1): an arriving alert
 * that did not consolidate is checked against OPEN incidents with activity inside this
 * window. 15 minutes per the spec's §6 knob table.
 */
export const ALERT_CORRELATION_WINDOW_DEFAULT_SECONDS = 900;

/**
 * @description Default dependency-bundling depth in hops (FR-D3) — 3, the depth the source
 * platform actually deployed (not its default 5; spec §6).
 */
export const ALERT_CORRELATION_DEPTH_DEFAULT = 3;

/**
 * @description Upper bound on how many recent tickets of the alert queue's type Stage D
 * scans for open-incident correlation (FR-D1). Stores list newest-first, so the window's
 * live incidents are always inside this bound at swarm scale; it exists only so a huge
 * historical queue can never turn one webhook POST into an unbounded table scan.
 */
export const ALERT_BUNDLE_CANDIDATE_LIMIT = 200;

/**
 * @description Shared fail-safe reader for numeric triage knobs (spec §9.8 — one source of
 * truth for defaults, and a bad value must never take down the intake). Read at intake
 * time, not module load, so a deployment can retune without a rebuild.
 * @param name - Environment variable name.
 * @param fallback - Default when unset or invalid.
 * @param opts - Validation options: `integer` requires a whole number; `min` is the lowest
 *   accepted value (default 0).
 * @returns The parsed knob value or the fallback.
 */
function envKnobNumber(name: string, fallback: number, opts: { integer?: boolean; min?: number } = {}): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isFinite(parsed) || parsed < min || (opts.integer === true && !Number.isInteger(parsed))) {
    logger.warn({ knob: name, raw }, 'Alert triage knob is not a valid number — using the default');
    return fallback;
  }
  return parsed;
}

/**
 * @description Resolves the Stage D correlation window in seconds from
 * `ALERT_CORRELATION_WINDOW` (FR-D1). `0` deliberately disables bundling; unset/invalid
 * values fall back to the 15m default.
 * @returns Window in seconds.
 */
export function correlationWindowSeconds(): number {
  return envKnobNumber('ALERT_CORRELATION_WINDOW', ALERT_CORRELATION_WINDOW_DEFAULT_SECONDS);
}

/**
 * @description Resolves the dependency-bundling depth in hops from
 * `ALERT_CORRELATION_DEPTH` (FR-D3). `0` disables dependency bundling (same-target
 * bundling is unaffected); unset/invalid values fall back to 3.
 * @returns Depth in hops.
 */
export function correlationDepth(): number {
  return envKnobNumber('ALERT_CORRELATION_DEPTH', ALERT_CORRELATION_DEPTH_DEFAULT, { integer: true });
}

/**
 * @description Resolves the recorded-member cap from `ALERT_MAX_MEMBERS` (FR-D5). Beyond
 * the cap, membership is counted in `membersOverflow` instead of recorded — never silent.
 * Minimum 1 (an incident always records its genesis member); unset/invalid → 50.
 * @returns Member cap.
 */
export function maxIncidentMembers(): number {
  return envKnobNumber('ALERT_MAX_MEMBERS', ALERT_MAX_INCIDENT_MEMBERS, { integer: true, min: 1 });
}

/**
 * @description Answers whether an incident's last activity is inside the correlation
 * window (FR-D1): `now - lastActivity <= window`. Unparseable timestamps return false —
 * an undatable incident never attracts a bundle.
 * @param lastActivityIso - ISO timestamp of the incident's last activity.
 * @param nowMs - Arrival epoch milliseconds (injected for deterministic guards).
 * @param windowSeconds - Window size in seconds.
 * @returns True when the incident is inside the window.
 */
export function isWithinCorrelationWindow(lastActivityIso: string, nowMs: number, windowSeconds: number): boolean {
  const activityMs = Date.parse(lastActivityIso);
  if (!Number.isFinite(activityMs)) return false;
  return (nowMs - activityMs) / 1000 <= windowSeconds;
}
