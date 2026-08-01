/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119) Stage A: canonical alert shape, target-resolution ladder, identity gate (FR-A2), incident-key rendering with fingerprint fallback (FR-C1 key hygiene), and the severity→priority mapping shared with the intake route (moved here from alertmanager-routes so consolidation escalation (FR-C4) and ticket creation rank severities identically)
 */

import type { TicketPriority } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'canonical-alert' });

/**
 * @description One alert inside an Alertmanager v4 webhook payload — the raw wire shape
 * the intake route receives and Stage A canonicalizes.
 */
export interface RawAlertmanagerAlert {
  status?: 'firing' | 'resolved';
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

/**
 * @description The canonical alert (FR-A1): identity fields resolved once at the door so
 * every later stage (claim gate, consolidation, bundling) reasons over the same shape.
 * `alertname`/`target` are '' when absent — never both (the identity gate drops that case).
 */
export interface CanonicalAlert {
  alertname: string;
  target: string;
  severity: string;
  status: 'firing' | 'resolved';
  firedAt: string | null;
  fingerprint: string;
  incidentKey: string;
  usedFingerprintKeyFallback: boolean;
  labels: Record<string, string>;
}

/** @description Result of rendering an incident key (FR-C1). */
export interface IncidentKeyRender {
  key: string;
  usedFingerprintFallback: boolean;
}

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

/**
 * @description Numeric rank of a ticket priority, used by the severity-only-escalates rule
 * (FR-C4): a refire may only move priority to a strictly higher rank, never lower.
 * @param priority - Ticket priority key.
 * @returns Rank (urgent=4 … none=0).
 */
export function priorityRank(priority: TicketPriority): number {
  return PRIORITY_RANK[priority] ?? 0;
}

/**
 * @description Maps an alert severity label to a ticket priority. Single mapping shared by
 * ticket creation (the intake route) and consolidation escalation (FR-C4) so the two paths
 * can never rank the same severity differently.
 * @param severity - Alert `severity` label (critical/page/warning/major/minor/info/none).
 * @returns Ticket priority.
 */
export function severityToPriority(severity?: string): TicketPriority {
  switch ((severity || '').toLowerCase()) {
    case 'critical':
    case 'page':
      return 'urgent';
    case 'warning':
    case 'major':
      return 'high';
    case 'minor':
      return 'medium';
    case 'info':
    case 'none':
      return 'low';
    default:
      return 'medium';
  }
}

/**
 * @description Resolves the failing target by the canonical ladder (FR-A1):
 * container > container_name > name > pod > instance > job. Returns '' when no rung matches
 * (the identity gate decides what happens then — display fallbacks stay at the surface).
 * @param labels - Alert labels.
 * @returns Resolved target or ''.
 */
export function resolveTarget(labels: Record<string, string>): string {
  return (
    labels.container ||
    labels.container_name ||
    labels.name ||
    labels.pod ||
    labels.instance ||
    labels.job ||
    ''
  ).trim();
}

/**
 * @description Renders the P1 incident key `{alertname}::{target}` (FR-C1). Key hygiene
 * (spec §9.6 / guard 10): a key that renders empty — no identity content beyond the
 * separator — falls back to the alert fingerprint with a warning, so distinct alerts can
 * never silently merge under a shared "empty" key.
 * @param alertname - Canonical alertname ('' when absent).
 * @param target - Canonical target ('' when absent).
 * @param fingerprint - Alert fingerprint (the fallback identity).
 * @returns The rendered key and whether the fingerprint fallback fired.
 */
export function renderIncidentKey(alertname: string, target: string, fingerprint: string): IncidentKeyRender {
  const rendered = `${alertname.trim()}::${target.trim()}`;
  const hasIdentity = rendered.replace(/[:\s]/g, '').length > 0;
  if (hasIdentity) {
    return { key: rendered, usedFingerprintFallback: false };
  }
  const fallback = fingerprint.trim() || 'unidentified-incident';
  logger.warn({ fingerprint: fallback }, 'Incident key rendered empty — falling back to the alert fingerprint (FR-C1 key hygiene)');
  return { key: fallback, usedFingerprintFallback: true };
}

/**
 * @description Stage A canonicalization + identity gate (FR-A1/FR-A2): resolves alertname,
 * target, severity, fingerprint and the incident key once. An alert with no alertname AND no
 * resolvable target is unactionable noise by definition — returns null so the caller counts
 * it as dropped (`reason=no_identity`, FR-A3) instead of opening an untargetable ticket.
 * @param alert - Raw Alertmanager v4 alert.
 * @returns The canonical alert, or null when the identity gate drops it.
 */
export function canonicalizeAlert(alert: RawAlertmanagerAlert): CanonicalAlert | null {
  const labels = alert.labels ?? {};
  const alertname = (labels.alertname ?? '').trim();
  const target = resolveTarget(labels);
  if (!alertname && !target) {
    logger.warn({ fingerprint: alert.fingerprint ?? null }, 'Alert has no alertname and no resolvable target — dropped (reason=no_identity)');
    return null;
  }
  const fingerprint = (alert.fingerprint ?? '').trim() || `${alertname || 'UnnamedAlert'}:${target || 'unknown-target'}`;
  const { key, usedFingerprintFallback } = renderIncidentKey(alertname, target, fingerprint);
  return {
    alertname,
    target,
    severity: (labels.severity ?? '').trim() || 'warning',
    status: alert.status === 'resolved' ? 'resolved' : 'firing',
    firedAt: alert.startsAt ?? null,
    fingerprint,
    incidentKey: key,
    usedFingerprintKeyFallback: usedFingerprintFallback,
    labels,
  };
}
