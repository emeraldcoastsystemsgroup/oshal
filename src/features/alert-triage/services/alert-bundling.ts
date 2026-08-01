/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): bundling correlation. Arrivals that did not consolidate are correlated against OPEN incidents with activity inside ALERT_CORRELATION_WINDOW — never only the arriving batch (FR-D1, the source platform's documented degenerate mode). Two match passes in strength order: same-target (FR-D2), then dependency-connected within ALERT_CORRELATION_DEPTH hops in either direction over the DependencyResolver seam (FR-D3/FR-D6). Root-cause candidate is the ported ordered policy (FR-D4): explicit ordered root filter (per-rule declarations arrive with the P3 claim registry) -> deepest dependency among members -> earliest firstSeen — recorded with the reason it won, a hint for RCA, never a verdict
 */

import type { InternalTicket } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import {
  TERMINAL_TICKET_STATES,
  correlationDepth,
  correlationWindowSeconds,
  isWithinCorrelationWindow,
} from './alert-triage-constants';
import type { CanonicalAlert } from './canonical-alert';
import { StaticDependencyMap, normalizeTarget, type DependencyResolver } from './dependency-map';
import { incidentOf, type IncidentMember, type IncidentRecord, type RootCandidate } from './incident-record';

const logger = createChildLogger({ module: 'alert-bundling' });

/** @description An open incident the arriving alert should attach to, and why (FR-D5). */
export interface BundleTarget {
  ticket: InternalTicket;
  attachReason: string;
}

/** @description An open-incident candidate paired with its parsed record. */
interface OpenIncidentCandidate {
  ticket: InternalTicket;
  incident: IncidentRecord;
}

/**
 * @description Unique normalized member targets of an incident (non-empty only).
 * @param incident - The incident record.
 * @returns Normalized member targets.
 */
function memberTargets(incident: IncidentRecord): string[] {
  const targets = new Set<string>();
  for (const member of incident.members) {
    const normalized = normalizeTarget(member.target);
    if (normalized) targets.add(normalized);
  }
  return [...targets];
}

/**
 * @description The incident's last-activity timestamp for the FR-D1 window check —
 * `incident.lastSeen` when parseable, else the ticket's own `updatedAt`.
 * @param candidate - Candidate ticket + incident.
 * @returns ISO timestamp of last activity.
 */
function lastActivityIso(candidate: OpenIncidentCandidate): string {
  return Number.isFinite(Date.parse(candidate.incident.lastSeen)) ? candidate.incident.lastSeen : candidate.ticket.updatedAt;
}

/**
 * @description Epoch ms of the incident's genesis, used to prefer the OLDEST matching
 * incident (the one the storm started with) when several correlate. Unparseable genesis
 * sorts last.
 * @param candidate - Candidate ticket + incident.
 * @returns Epoch milliseconds (MAX_SAFE_INTEGER when unparseable).
 */
function firstSeenMs(candidate: OpenIncidentCandidate): number {
  const ms = Date.parse(candidate.incident.firstSeen);
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

/**
 * @description Per-target aggregation for the root-candidate policy: the raw label to
 * record plus the earliest firstSeen among that target's members (tie-breaker).
 */
interface TargetInfo {
  raw: string;
  firstSeenMs: number;
}

/**
 * @description Unique member targets keyed by normalized name, each carrying its raw label
 * and earliest firstSeen.
 * @param members - Incident members.
 * @returns Normalized-target map.
 */
function uniqueMemberTargets(members: IncidentMember[]): Map<string, TargetInfo> {
  const map = new Map<string, TargetInfo>();
  for (const member of members) {
    const key = normalizeTarget(member.target);
    if (!key) continue;
    const parsed = Date.parse(member.firstSeen);
    const seenMs = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    const existing = map.get(key);
    if (!existing || seenMs < existing.firstSeenMs) map.set(key, { raw: member.target, firstSeenMs: seenMs });
  }
  return map;
}

/**
 * @description Stage D bundling (ADR-119 P2). Pure correlation logic over caller-provided
 * candidate tickets — the consolidation service supplies the open-ticket listing and applies
 * the attach; this class only answers "which open incident, and why" (FR-D1/D2/D3) and
 * "which member is the root candidate" (FR-D4).
 */
export class AlertBundlingService {
  /**
   * @param dependencies - Dependency resolver (FR-D6 seam). Defaults to the static
   *   compose-topology map; an ADR-045 graph-backed resolver may be injected instead.
   */
  constructor(private readonly dependencies: DependencyResolver = StaticDependencyMap.fromEnvironment()) {}

  /**
   * @description Finds the open incident an arriving (non-consolidated) alert belongs to:
   * same-target first (FR-D2), then dependency-connected within the depth bound (FR-D3) —
   * only among incidents with activity inside ALERT_CORRELATION_WINDOW (FR-D1). Among
   * multiple matches the OLDEST incident wins (the alert joins the storm's origin).
   * @param candidateTickets - Recent tickets of the alert queue's type (any status; filtered here).
   * @param alert - The canonical arriving alert.
   * @param nowMs - Arrival time in epoch ms (injected for deterministic guards).
   * @returns The bundle target with its attach reason, or null when nothing correlates.
   */
  async findBundleTarget(candidateTickets: InternalTicket[], alert: CanonicalAlert, nowMs: number): Promise<BundleTarget | null> {
    const windowSeconds = correlationWindowSeconds();
    const target = normalizeTarget(alert.target);
    if (windowSeconds <= 0 || !target) return null;

    const open = candidateTickets
      .map((ticket) => ({ ticket, incident: incidentOf(ticket) }))
      .filter((c): c is OpenIncidentCandidate => c.incident !== null)
      .filter((c) => !TERMINAL_TICKET_STATES.has(c.ticket.status))
      .filter((c) => c.incident.key !== alert.incidentKey)
      .filter((c) => isWithinCorrelationWindow(lastActivityIso(c), nowMs, windowSeconds))
      .sort((a, b) => firstSeenMs(a) - firstSeenMs(b));
    if (open.length === 0) return null;

    const sameTarget = open.find((c) => memberTargets(c.incident).includes(target));
    if (sameTarget) return { ticket: sameTarget.ticket, attachReason: 'same-target' };

    const depth = correlationDepth();
    if (depth < 1) return null;
    for (const candidate of open) {
      for (const member of memberTargets(candidate.incident)) {
        const hops = await this.connectionHops(target, member, depth);
        if (hops !== null) {
          logger.info(
            { incidentKey: candidate.incident.key, alertTarget: target, memberTarget: member, hops },
            'Arriving alert dependency-correlates with an open incident (FR-D3)',
          );
          return { ticket: candidate.ticket, attachReason: `dependency:${member}@${hops}` };
        }
      }
    }
    return null;
  }

  /**
   * @description "Connected within depth" in EITHER direction (FR-D3: an alert on X bundles
   * into an open incident on a dependency of X, and vice versa). Identical targets do not
   * count — that is same-target bundling's business.
   * @param a - One target.
   * @param b - The other target.
   * @param depth - Maximum hops.
   * @returns The smallest connecting hop count (>= 1), or null.
   */
  private async connectionHops(a: string, b: string, depth: number): Promise<number | null> {
    const forward = await this.dependencies.dependencyDistance(a, b, depth);
    const backward = await this.dependencies.dependencyDistance(b, a, depth);
    const hops = [forward, backward].filter((d): d is number => d !== null && d >= 1);
    return hops.length > 0 ? Math.min(...hops) : null;
  }

  /**
   * @description FR-D4 — the ordered root-candidate policy (port of the source platform's
   * designed-but-unshipped leading_event_filter): (1) first entry of an explicit ordered
   * root filter that matches a member target (per-rule declarations arrive with the P3 claim
   * registry; the mechanism ships proven now), (2) the deepest dependency among members —
   * the target the most hops downstream of another alerting member, (3) earliest firstSeen.
   * @param members - The incident's recorded members.
   * @param rootFilter - Optional ordered target filter, first match wins.
   * @returns The root candidate and the policy step that chose it.
   */
  async chooseRootCandidate(members: IncidentMember[], rootFilter: readonly string[] = []): Promise<RootCandidate> {
    const targets = uniqueMemberTargets(members);
    for (const pattern of rootFilter) {
      const hit = targets.get(normalizeTarget(pattern));
      if (hit) return { target: hit.raw, reason: `root-filter:${pattern}` };
    }
    const deepest = await this.deepestDependencyTarget(targets);
    if (deepest) return { target: deepest, reason: 'deepest-dependency' };
    return { target: earliestMemberTarget(members), reason: 'earliest-first-seen' };
  }

  /**
   * @description Policy step 2: score each member target by the deepest depends-on distance
   * any OTHER member target has to it; the highest-scoring target (>= 1 hop) wins, earliest
   * firstSeen breaking ties. Null when no dependency relations exist among members.
   * @param targets - Unique member targets.
   * @returns The winning raw target label, or null.
   */
  private async deepestDependencyTarget(targets: Map<string, TargetInfo>): Promise<string | null> {
    const depth = correlationDepth();
    let best: { info: TargetInfo; score: number } | null = null;
    for (const [key, info] of targets) {
      let score = 0;
      for (const [otherKey] of targets) {
        if (otherKey === key) continue;
        const d = await this.dependencies.dependencyDistance(otherKey, key, depth);
        if (d !== null && d > score) score = d;
      }
      if (score >= 1 && (best === null || score > best.score || (score === best.score && info.firstSeenMs < best.info.firstSeenMs))) {
        best = { info, score };
      }
    }
    return best ? best.info.raw : null;
  }
}

/**
 * @description Policy step 3 fallback: the target (or, failing that, alertname) of the
 * member with the earliest parseable firstSeen.
 * @param members - Incident members (never empty on a real incident).
 * @returns Raw target label of the earliest member.
 */
function earliestMemberTarget(members: IncidentMember[]): string {
  let earliest: IncidentMember | null = null;
  let earliestMs = Number.MAX_SAFE_INTEGER;
  for (const member of members) {
    const parsed = Date.parse(member.firstSeen);
    const ms = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    if (earliest === null || ms < earliestMs) {
      earliest = member;
      earliestMs = ms;
    }
  }
  if (!earliest) return '';
  return earliest.target || earliest.alertname;
}
