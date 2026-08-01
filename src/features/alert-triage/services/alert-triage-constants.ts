/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): the ONE constants module for triage defaults (spec §9.8 — the source platform shipped a knob whose documented default and read-site default disagreed; every triage stage reads its defaults from here)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): the bundling knobs — ALERT_CORRELATION_WINDOW (FR-D1, default 15m), ALERT_CORRELATION_DEPTH (FR-D3, default 3 — the depth the source platform actually deployed), ALERT_MAX_MEMBERS (FR-D5 — the P1 member cap becomes the spec's configurable knob), the correlation-window predicate, and the bundle-candidate listing bound. All read at intake time with fail-safe fallbacks via one shared parser
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage B + E): the dispatch-gate knobs — ALERT_RCA_HOURLY_BUDGET_USD (FR-E2, default $10/h — the source platform's shipped default), the flap-damping trio ALERT_FLAP_THRESHOLD/_WINDOW/_QUIET (FR-E3, defaults 5/30m/10m), ALERT_AUTO_RESOLVE (FR-E4, default OFF — a knob that ships only with its guard, spec §9.9), plus the budget gate's non-env constants (reservation TTL, p95 sample bound, first-run reserve fallback). Same fail-safe read-at-intake-time posture as P1/P2
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 (ADR-119 A2): the autonomy knobs — SELF_HEAL_AUTO_APPLY (the kill switch, default FALSE; off = A1 exactly), SELF_HEAL_APPLY_HOURLY_CAP (global sliding-hour apply cap, default 3, 0 parks everything visibly) and SELF_HEAL_VERIFY_TIMEOUT (post-apply verification window, default 120s, min 1). Every knob ships with a named guard in tests/unit/alert-triage-autonomy.spec.ts (§9.9)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added ALERT_INTAKE_OWNER_SUB — the synthetic machine owner the alert intake writes under. The live container-kill drill proved the whole ladder could not create a single ticket: the webhook carries no user identity, so the request-identity middleware stamped anonymous non-operator and the owner-RLS WITH CHECK refused every INSERT ("new row violates row-level security policy for table tickets"). This is the identity; the route stamps it on the connection and createIncidentTicket stamps the matching owner_sub — one constant so the two halves can never drift.
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
 * @description The synthetic owner sub every alert-born ticket is created under — and the
 * identity the machine intake path stamps on its database connection, so the two halves of
 * the owner RLS predicate agree (`owner_sub = current_setting('oshal.current_sub')`).
 *
 * WHY THIS EXISTS: the Alertmanager webhook is a MACHINE caller. It authenticates with a
 * shared bearer token and there is no human behind it, so the request-identity middleware
 * stamps anonymous non-operator — and under the enforce-stage owner policy
 * (docs/governance/rls-policies-enforce.sql) an anonymous connection cannot insert into
 * `tickets` at all. Proven live on 2026-08-01: a valid, authenticated, claim-passing alert
 * reached `createIncidentTicket` and the INSERT was refused with
 * "new row violates row-level security policy for table tickets".
 *
 * THE RAIL THIS FOLLOWS is the A2A gateway's `ownerSubForA2aAgent()` (`a2a:<agentId>`,
 * src/features/a2a-gateway): an authenticated machine caller gets a SYNTHETIC, namespaced
 * owner sub and runs `isOperator: false`, so every per-owner rail (RLS, budgets, "my
 * tickets", DLQ attribution) applies to it with no special-casing.
 *
 * DELIBERATELY NOT the two alternatives:
 *   - `runWithSystemIdentity` (operator, owner-less) would hand a token-holding webhook
 *     operator-wide visibility: Stage D's bundle scan lists recent tickets of the queue's
 *     type, so an operator-stamped intake could correlate an alert onto ANOTHER tenant's
 *     ticket, and the resulting row would have no owner for any per-owner rail to attribute.
 *     Non-operator scopes that scan to alert-born tickets, which is exactly Stage C/D's
 *     intended blast radius.
 *   - the deployment operator's sub (OSHAL_OPERATOR_SUBS) would attribute machine-authored
 *     work to a human who did not cause the alert.
 *
 * The `prometheus` suffix matches the `externalProvider: 'prometheus'` already stamped on
 * every alert-born ticket, so owner and provenance agree. It is a namespace, not a knob:
 * making it configurable would let a deployment point machine writes at a real user's sub.
 */
export const ALERT_INTAKE_OWNER_SUB = 'alert:prometheus';

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

/**
 * @description Default sliding-hour analyst budget in USD (FR-E2) — $10/h, the source
 * platform's shipped default for its enricher cost guard (spec §6). The gate compares
 * chat_tasks-derived actuals + live reservations against this cap before an auto-flow
 * dispatch; over budget parks the ticket visibly, never silently.
 */
export const ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD = 10;

/**
 * @description Default flap threshold (FR-E3): this many refires inside the flap window
 * marks the incident `flapping` (spec §6).
 */
export const ALERT_FLAP_THRESHOLD_DEFAULT = 5;

/** @description Default flap observation window in seconds (FR-E3) — 30 minutes. */
export const ALERT_FLAP_WINDOW_DEFAULT_SECONDS = 1800;

/**
 * @description Default quiet period in seconds (FR-E3) — 10 minutes without refires ends a
 * flap episode; a flap-parked incident may then return to its auto-flow status.
 */
export const ALERT_FLAP_QUIET_DEFAULT_SECONDS = 600;

/**
 * @description How long (seconds) a budget reservation counts against the sliding-hour
 * spend before it is presumed realized (FR-E2 true-up). recordCost lands an RCA run's
 * actuals in the cost ledger as the run executes; once a reservation is this old, the
 * actuals read already reflects the run it reserved for, so keeping the reservation alive
 * would double-count. A NON-env constant on purpose: a knob nobody's guard exercises is
 * the §9.9 trap.
 */
export const ALERT_RCA_RESERVATION_TTL_SECONDS = 900;

/**
 * @description Reservation estimate used when the cost ledger has no per-RCA history yet
 * (first dispatches on a fresh deployment). Deliberately modest: the guard direction on an
 * empty ledger is "let analysis run and learn real costs", not "park on a guess".
 */
export const ALERT_RCA_RESERVE_FALLBACK_USD = 0.5;

/**
 * @description How many recent per-RCA ticket costs feed the p95 reservation estimate
 * (FR-E2 "reserve the recent p95 per-RCA cost").
 */
export const ALERT_RCA_COST_SAMPLE_LIMIT = 20;

/**
 * @description Resolves the sliding-hour analyst budget in USD from
 * `ALERT_RCA_HOURLY_BUDGET_USD` (FR-E2). `0` is a real value — zero budget parks every
 * auto-flow dispatch (visibly); unset/invalid values fall back to $10.
 * @returns Budget in USD.
 */
export function rcaHourlyBudgetUsd(): number {
  return envKnobNumber('ALERT_RCA_HOURLY_BUDGET_USD', ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD);
}

/**
 * @description Resolves the flap threshold from `ALERT_FLAP_THRESHOLD` (FR-E3).
 * Minimum 1; unset/invalid → 5.
 * @returns Refire count that marks an incident flapping.
 */
export function flapThreshold(): number {
  return envKnobNumber('ALERT_FLAP_THRESHOLD', ALERT_FLAP_THRESHOLD_DEFAULT, { integer: true, min: 1 });
}

/**
 * @description Resolves the flap observation window in seconds from `ALERT_FLAP_WINDOW`
 * (FR-E3). `0` deliberately disables flap damping; unset/invalid → 30m.
 * @returns Window in seconds.
 */
export function flapWindowSeconds(): number {
  return envKnobNumber('ALERT_FLAP_WINDOW', ALERT_FLAP_WINDOW_DEFAULT_SECONDS);
}

/**
 * @description Resolves the flap quiet period in seconds from `ALERT_FLAP_QUIET` (FR-E3).
 * Unset/invalid → 10m. `0` means any gap ends the episode (effectively: the next refire
 * after a flap always restores) — permitted, but the default is the deliberate value.
 * @returns Quiet period in seconds.
 */
export function flapQuietSeconds(): number {
  return envKnobNumber('ALERT_FLAP_QUIET', ALERT_FLAP_QUIET_DEFAULT_SECONDS);
}

/**
 * @description Resolves the FR-E4 auto-resolve opt-in from `ALERT_AUTO_RESOLVE`.
 * Default **false** (spec §6): auto-closing work — even fully-self-resolved backlog work —
 * is outward-acting automation and stays opt-in per the standing directive. Only the
 * explicit affirmatives enable it; anything else is off.
 * @returns True when backlog auto-close on full member resolution is enabled.
 */
export function autoResolveEnabled(): boolean {
  const raw = (process.env.ALERT_AUTO_RESOLVE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * @description Default global sliding-hour auto-apply cap (ADR-119 A2 bound 2): at most
 * this many unattended applies across ALL incidents per hour, so a correlated failure
 * (one bad image everywhere) becomes one escalation, not a fleet-wide restart storm.
 */
export const SELF_HEAL_APPLY_HOURLY_CAP_DEFAULT = 3;

/**
 * @description Default verification window in seconds (ADR-119 A2 bound 3): after an
 * auto-apply the target must be OBSERVED healthy inside this window or the ticket
 * escalates instead of completing.
 */
export const SELF_HEAL_VERIFY_TIMEOUT_DEFAULT_SECONDS = 120;

/**
 * @description Resolves the A2 kill switch from `SELF_HEAL_AUTO_APPLY` (ADR-119). Default
 * **false** — explicit per-deployment opt-in, per the automation directive: with the
 * switch off, A2 behaves exactly as A1 (proposals queue at the approve gate, nothing
 * applies). Only the explicit affirmatives enable it; anything else is off.
 * @returns True when bounded unattended remediation is enabled.
 */
export function autoApplyEnabled(): boolean {
  const raw = (process.env.SELF_HEAL_AUTO_APPLY ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * @description Resolves the global hourly apply cap from `SELF_HEAL_APPLY_HOURLY_CAP`
 * (ADR-119 A2 bound 2). `0` is a real value — it parks every apply at the gate (visibly);
 * unset/invalid → 3.
 * @returns Applies allowed per sliding hour.
 */
export function autoApplyHourlyCap(): number {
  return envKnobNumber('SELF_HEAL_APPLY_HOURLY_CAP', SELF_HEAL_APPLY_HOURLY_CAP_DEFAULT, { integer: true });
}

/**
 * @description Resolves the post-apply verification window in seconds from
 * `SELF_HEAL_VERIFY_TIMEOUT` (ADR-119 A2 bound 3). Minimum 1 — a zero window would make
 * every verification fail and could never be the deliberate setting; unset/invalid → 120.
 * @returns Verification window in seconds.
 */
export function autoApplyVerifyTimeoutSeconds(): number {
  return envKnobNumber('SELF_HEAL_VERIFY_TIMEOUT', SELF_HEAL_VERIFY_TIMEOUT_DEFAULT_SECONDS, { integer: true, min: 1 });
}
