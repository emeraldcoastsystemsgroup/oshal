/**
 * SIEM / syslog forwarder for governance audit events.
 *
 * `audit-emit` writes per-resource access events to Postgres for export. Enterprises also want those
 * events streamed to their SIEM (Splunk/Elastic/Sentinel) in near-real-time. This module formats an
 * event and ships it to a configured HTTP collector, in syslog (RFC 5424) or JSON-lines form.
 *
 * OFF BY DEFAULT: with no `OSHAL_AUDIT_FORWARD_URL` set, {@link forwardAuditEvent} is a no-op. Sends
 * are best-effort and NEVER throw into the caller (the audit path must not be able to break a
 * request). `fetch` is injectable for tests.
 *
 * @module features/governance/audit/forwarder
 */

/** The minimal event shape we forward (compatible with audit-emit's AuditEvent + a timestamp). */
export interface ForwardableAuditEvent {
  actorSub: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  decision?: string;
  metadata?: Record<string, unknown> | null;
  /** ISO timestamp; caller supplies (audit-emit rows carry created_at). */
  timestamp?: string;
}

export type ForwarderFormat = 'json' | 'syslog';

export interface ForwarderConfig {
  enabled: boolean;
  endpoint: string | null;
  format: ForwarderFormat;
  /** Optional bearer token for the collector. */
  token: string | null;
}

/** @description Read forwarder config from env. Disabled unless OSHAL_AUDIT_FORWARD_URL is set. */
export function forwarderConfig(env: NodeJS.ProcessEnv = process.env): ForwarderConfig {
  const endpoint = (env.OSHAL_AUDIT_FORWARD_URL ?? '').trim() || null;
  const fmt = (env.OSHAL_AUDIT_FORWARD_FORMAT ?? 'json').toLowerCase().trim();
  return {
    enabled: !!endpoint,
    endpoint,
    format: fmt === 'syslog' ? 'syslog' : 'json',
    token: (env.OSHAL_AUDIT_FORWARD_TOKEN ?? '').trim() || null,
  };
}

/** RFC 5424 severity for an audit decision: deny=warning(4), allow/info=informational(6). */
function severityFor(decision?: string): number {
  return decision === 'deny' ? 4 : 6;
}

/** @description Format an event as one JSON line. */
export function formatJsonLine(event: ForwardableAuditEvent): string {
  return JSON.stringify({
    ts: event.timestamp ?? null,
    actor: event.actorSub,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    decision: event.decision ?? 'info',
    metadata: event.metadata ?? null,
  });
}

/**
 * @description Format an event as an RFC 5424 syslog line. Facility 13 (log audit) * 8 + severity.
 * STRUCTURED-DATA carries the fields; MSG is a short human summary.
 */
export function formatSyslog(event: ForwardableAuditEvent, host = 'oshal'): string {
  const pri = 13 * 8 + severityFor(event.decision);
  const ts = event.timestamp ?? '-';
  const actor = event.actorSub ?? '-';
  const esc = (v: unknown) => String(v ?? '').replace(/[\\\]"]/g, (c) => '\\' + c);
  const sd =
    `[oshal@47000 actor="${esc(actor)}" action="${esc(event.action)}" ` +
    `resourceType="${esc(event.resourceType)}" resourceId="${esc(event.resourceId ?? '-')}" ` +
    `decision="${esc(event.decision ?? 'info')}"]`;
  return `<${pri}>1 ${ts} ${host} oshal-audit - - ${sd} ${event.action} ${event.decision ?? 'info'}`;
}

/** Minimal fetch signature we depend on (keeps tests free of DOM/node typings friction). */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number }>;

/**
 * @description Forward one audit event to the configured collector. No-op (returns false) when
 * disabled. Best-effort: any error is swallowed (returns false); a 2xx returns true. NEVER throws.
 *
 * @param event The event to ship.
 * @param deps Injectable fetch + env (defaults to global fetch + process.env).
 */
export async function forwardAuditEvent(
  event: ForwardableAuditEvent,
  deps: { fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const cfg = forwarderConfig(env);
  if (!cfg.enabled || !cfg.endpoint) return false;

  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return false;

  try {
    const body = cfg.format === 'syslog' ? formatSyslog(event) : formatJsonLine(event);
    const headers: Record<string, string> = {
      'Content-Type': cfg.format === 'syslog' ? 'text/plain; charset=utf-8' : 'application/json',
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await doFetch(cfg.endpoint, { method: 'POST', headers, body });
    return !!res && res.ok;
  } catch {
    return false; // audit forwarding must never break the caller
  }
}
