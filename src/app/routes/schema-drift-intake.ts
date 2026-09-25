/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit native schema alarms through a persisted rule and the existing ticket service, with explicit source evidence and manual-only handling.
 */

import { PIPELINE_OWNER_SUB, renderDedupKey, renderIdentitySource, type AlertEventRow, type Queryable } from '@/features/alert-pipeline';
import type { TicketService } from '@/features/ticketing';
import type { TicketType } from '@/entities/ticket';
import { matchesPredicate } from './ops-pipeline-rule-validation';

export const SCHEMA_DRIFT_SOURCE = 'schema-drift';
const FIELDS = ['target', 'alertname', 'labels.schema_occurrence'];

/**
 * @description Namespace a digest transition separately from webhook incidents and other transitions.
 * @param event - A normalized schema producer event, not a reconstructed webhook.
 * @param deployment - Existing deployment namespace.
 * @returns Stable incident identity for the occurrence.
 */
export function schemaDriftIdentity(event: AlertEventRow, deployment: string): { dedupKey: string; identitySource: string } {
  const identity = { ...event, labels: { ...event.labels, schema_occurrence: event.fingerprint } };
  return { dedupKey: renderDedupKey(identity, FIELDS, `${deployment}:schema-drift`), identitySource: renderIdentitySource(identity, FIELDS) };
}

/**
 * @description Claim a schema occurrence with the dedicated live rule; create one parked ticket
 * via the standard unique external-provider/id claim. Rule edits never authorize remediation.
 * @param db - Caller-scoped database for current rule configuration.
 * @param tickets - Existing ticket service and its durable external-id uniqueness.
 * @param event - The internal event whose before/after evidence the operator must see.
 * @param ticketType - Existing configured incident workflow type, held for operator approval.
 * @returns A normal intake decision for the shared effect, incident and dispatch bookkeeping.
 */
export async function intakeSchemaDrift(db: Queryable, tickets: TicketService, event: AlertEventRow, ticketType: TicketType) {
  const rule = (await db.query(`SELECT enabled, match_predicate FROM oshal_alert_claim_rule WHERE rule_id = $1`, [SCHEMA_DRIFT_SOURCE])).rows[0];
  if (!rule) return { decision: 'noise' as const, unclaimedReason: 'no_rule_match' as const };
  if (!rule.enabled) return { decision: 'noise' as const, unclaimedReason: 'rule_disabled' as const };
  if (!matchesPredicate(rule.match_predicate, event)) return { decision: 'noise' as const, unclaimedReason: 'no_rule_match' as const };
  if (!event.target || !event.fingerprint || event.status !== 'firing') return { decision: 'dropped' as const, unclaimedReason: 'no_identity' as const };
  const previous = await tickets.findLatestTicketByMetadataKey('schemaDriftOccurrence', event.fingerprint);
  if (previous && (previous.ownerSub !== PIPELINE_OWNER_SUB || previous.externalProvider !== SCHEMA_DRIFT_SOURCE || previous.externalId !== event.fingerprint)) {
    throw new Error('Stored schema alarm ticket does not match its owner and occurrence.');
  }
  const ticket = previous ?? await tickets.createTicket({
    title: `Schema drift in ${event.target}`, ticketType, status: 'approval_required', priority: 'high',
    ownerSub: PIPELINE_OWNER_SUB, externalProvider: SCHEMA_DRIFT_SOURCE, externalId: event.fingerprint,
    externalUrl: '/data-model/', workspaceId: null, assignedAgentId: null, parentTicketId: null,
    description: [event.summary, event.annotations.description,
      `Baseline: ${event.annotations.baseline_at ?? 'unknown'}`,
      'Source: internal schema-drift detector. Parked for operator review; no automatic remediation.'].filter(Boolean).join('\n\n'),
    labels: [SCHEMA_DRIFT_SOURCE, 'incident', 'intake:manual'],
    metadata: { source: SCHEMA_DRIFT_SOURCE, schemaDriftOccurrence: event.fingerprint,
      alertEventId: event.eventId, schemaDrift: event.annotations },
  });
  return { decision: previous ? 'consolidated' as const : 'created' as const, ticketId: ticket.ticketId,
    intakeStatus: 'backlog', claimRuleId: SCHEMA_DRIFT_SOURCE };
}
