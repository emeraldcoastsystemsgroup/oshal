/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reject malformed internal events before acquiring a database connection; detach producer-owned mutable input.
 */

import { SEVERITY_RANK } from './alert-pipeline-types';
import type { NormalizedAlertInput } from './envelope-store';
import type { InternalEventInput } from './internal-event-receipt';

function invalid(): never {
  throw Object.assign(new Error('Invalid normalized internal alert.'), { code: 'ALERT_PRODUCER_INVALID' });
}

function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid();
  return value;
}

function date(value: unknown): Date | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return new Date(value.getTime());
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  const entries = Object.entries(value);
  if (entries.length > 128) invalid();
  for (const [key, item] of entries) {
    text(key, 256);
    if (typeof item !== 'string' || item.length > 65_536 || item.includes('\0')) invalid();
  }
  return Object.fromEntries(entries);
}

/** Validate values without re-normalizing or inventing transport facts for a trusted producer. */
function validateEvent(event: NormalizedAlertInput): NormalizedAlertInput {
  if (!event || typeof event !== 'object') invalid();
  if (typeof event.severity !== 'string' || !Object.hasOwn(SEVERITY_RANK, event.severity) || SEVERITY_RANK[event.severity] !== event.severityNum) invalid();
  if (event.status !== 'firing' && event.status !== 'resolved') invalid();
  if (event.targetKind !== null && !['container', 'container_name', 'name', 'pod', 'instance', 'job'].includes(event.targetKind)) invalid();
  return {
    fingerprint: text(event.fingerprint, 256)!, alertname: text(event.alertname, 256)!,
    target: text(event.target, 1024)!, targetKind: event.targetKind,
    severity: event.severity, severityNum: event.severityNum, status: event.status,
    startedAt: date(event.startedAt), endedAt: date(event.endedAt),
    generatorUrl: text(event.generatorUrl, 2048, true),
    labels: stringMap(event.labels), annotations: stringMap(event.annotations),
    summary: text(event.summary, 500, true), namespace: text(event.namespace, 1024, true),
    container: text(event.container, 1024, true), instance: text(event.instance, 1024, true),
    job: text(event.job, 1024, true),
  };
}

/**
 * @description Copy and bound a normalized producer event before any asynchronous database work.
 * @param input - Internal code's event; never an HTTP or Alertmanager body.
 * @returns Detached, validated input. Throws ALERT_PRODUCER_INVALID on a contract violation.
 */
export function validateInternalEvent(input: InternalEventInput): InternalEventInput {
  if (!input || typeof input !== 'object') invalid();
  const source = text(input.source, 64)!;
  if (!/^[a-z][a-z0-9-]*$/.test(source) || ['alertmanager', 'prometheus'].includes(source)) invalid();
  const result = { source, producerKey: text(input.producerKey, 512)!, event: validateEvent(input.event) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 262_144) invalid();
  return result;
}
