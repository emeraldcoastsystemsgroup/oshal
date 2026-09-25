/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Translate settled schema drift into a genuine internal producer event with stable occurrence identity and complete before/after evidence.
 */

import { createHash } from 'node:crypto';
import { diffDigests, type SchemaDigest } from '@/features/data-model';
import type { InternalEventInput } from '@/features/alert-pipeline';

/**
 * @description Build an internal alarm only for unexplained, settled drift. Repeated reads of
 * the same baseline/current shape produce byte-equivalent content despite a new scan timestamp.
 * The caller retains baseline control; constructing an event neither captures nor publishes it.
 * @param previous - Explicitly recorded baseline, or null when none exists.
 * @param current - Newly read structure-only digest.
 * @param nowMs - Detector clock used by the existing quiet-window classifier.
 * @returns Normalized internal event, or null for a non-alarm state. Refused reads still throw.
 */
export function schemaDriftEvent(previous: SchemaDigest | null, current: SchemaDigest, nowMs = Date.now()): InternalEventInput | null {
  const report = diffDigests(previous, current, { nowMs });
  if (!report.alarm || !previous) return null;
  const producerKey = createHash('sha256').update(JSON.stringify([
    current.database, previous.fingerprint, previous.capturedAt, current.fingerprint,
  ])).digest('hex');
  const description = report.changes.map((change) =>
    `${change.relation}: ${change.kind}; before: ${change.before}; after: ${change.after}`).join('\n');
  const summary = `Schema drift in ${current.database}: ${report.changes.length} structural change(s).`.slice(0, 500);
  return {
    source: 'schema-drift', producerKey,
    event: {
      fingerprint: producerKey, alertname: 'SchemaDrift', target: current.database,
      targetKind: null, severity: 'warning', severityNum: 3, status: 'firing',
      startedAt: null, endedAt: null, generatorUrl: '/data-model/',
      labels: { alertname: 'SchemaDrift', severity: 'warning', database: current.database, intake: 'backlog' },
      annotations: {
        summary, description, changes: JSON.stringify(report.changes),
        baseline_at: previous.capturedAt, baseline_fingerprint: previous.fingerprint,
        current_fingerprint: current.fingerprint,
      },
      summary, namespace: null, container: null, instance: null, job: null,
    },
  };
}
