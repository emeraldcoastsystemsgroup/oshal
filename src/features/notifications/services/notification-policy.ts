/**
 * Notifications — the severity → transport routing policy.
 *
 * `notifyOperator` sends over ONE transport and `notifyAll` fans over EVERY configured one; this
 * module is the layer between: given a severity (info/warn/error/critical), which transport(s) should
 * carry it. Low-severity events whisper on a single first-party channel; a critical event pages every
 * escalation leg (text + call + email). The map is a sensible default that an operator can override
 * per level with `NOTIFY_POLICY_<LEVEL>` env (comma-separated transport kinds), and every resolved
 * set is intersected with the transports that are ACTUALLY configured — so an unconfigured leg is
 * silently dropped rather than producing a failed send. Nothing here throws.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NotifySeverity union, DEFAULT_SEVERITY_POLICY, env override (NOTIFY_POLICY_<LEVEL>), transportsForSeverity (policy ∩ configured), and notifyBySeverity (resolve → notifyAll, degrades to a single skipped noop when nothing is configured for the level).
 *
 * @module features/notifications/services/notification-policy
 */

import { createChildLogger } from '@/shared/logger';
import { TRANSPORT_KINDS, type NotificationMessage, type NotificationResult, type TransportDeps, type TransportKind } from '../types';
import { configuredTransportKinds, notifyAll } from './notification-service';

const logger = createChildLogger({ module: 'notifications:policy' });

/** Severity levels a producer can page at, low → high. */
export const NOTIFY_SEVERITIES = ['info', 'warn', 'error', 'critical'] as const;

/** One severity level. */
export type NotifySeverity = (typeof NOTIFY_SEVERITIES)[number];

/** A full mapping of every severity to the ordered transport kinds that should carry it. */
export type SeverityPolicy = Record<NotifySeverity, TransportKind[]>;

/**
 * The default severity → transport policy. Escalates with severity: info/warn whisper on the
 * first-party Telegram channel; error adds an email trail + a phone text; critical also places a
 * call. Each leg is dropped at send time if that transport is not configured, so this default is
 * safe even on a deployment that wired only one channel.
 */
export const DEFAULT_SEVERITY_POLICY: SeverityPolicy = {
  info: ['telegram'],
  warn: ['telegram', 'email'],
  error: ['telegram', 'email', 'twilio-sms'],
  critical: ['telegram', 'email', 'twilio-sms', 'twilio-voice'],
};

/** The set of valid non-noop transport names, for validating env-supplied policy entries. */
const VALID_KINDS = new Set<string>(TRANSPORT_KINDS.filter((k) => k !== 'noop'));

/** Parse a comma-separated env value into valid, de-duplicated transport kinds (unknown names dropped + logged). */
function parseKinds(raw: string | undefined, level: NotifySeverity): TransportKind[] | undefined {
  if (raw === undefined) return undefined;
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  const valid = wanted.filter((k) => VALID_KINDS.has(k)) as TransportKind[];
  const unknown = wanted.filter((k) => !VALID_KINDS.has(k));
  if (unknown.length) logger.warn({ level, unknown }, 'NOTIFY_POLICY override lists unknown transport kinds — dropping them');
  return [...new Set(valid)];
}

/**
 * @description Resolve the effective severity policy: the default, with any `NOTIFY_POLICY_<LEVEL>`
 * env override replacing that level's transports. An override to an empty/all-invalid list means
 * "no transports for this level" (an explicit mute), distinct from an unset override (keep default).
 * @param env - Env source (defaults to process.env).
 * @returns The resolved policy for all four levels.
 */
export function severityPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SeverityPolicy {
  const resolved = { ...DEFAULT_SEVERITY_POLICY };
  for (const level of NOTIFY_SEVERITIES) {
    const override = parseKinds(env[`NOTIFY_POLICY_${level.toUpperCase()}`], level);
    if (override !== undefined) resolved[level] = override;
  }
  return resolved;
}

/**
 * @description The transport kinds a given severity should route to. By default the policy set is
 * intersected with the currently-configured transports (so an unconfigured leg is dropped); pass
 * `onlyConfigured: false` to get the raw policy set (what the policy WANTS, independent of config).
 * @param severity - The event severity.
 * @param opts - Optional explicit policy, injected deps (env/fetch/email rail), and the config filter.
 * @returns The transport kinds to send over (never includes 'noop').
 */
export function transportsForSeverity(
  severity: NotifySeverity,
  opts: { policy?: SeverityPolicy; deps?: TransportDeps; onlyConfigured?: boolean } = {},
): TransportKind[] {
  const policy = opts.policy ?? severityPolicyFromEnv(opts.deps?.env);
  const wanted = [...new Set(policy[severity] ?? [])].filter((k) => k !== 'noop');
  if (opts.onlyConfigured === false) return wanted;
  const configured = new Set(configuredTransportKinds(opts.deps ?? {}));
  return wanted.filter((k) => configured.has(k));
}

/**
 * @description Send one notification at a severity: resolve the policy → configured transports, then
 * fan across them via notifyAll. Never throws. When the level maps to no configured transport it
 * returns a single `skipped` noop result so the caller sees an explicit outcome (not silence).
 * @param severity - The event severity.
 * @param message - The notification (text + optional media).
 * @param opts - Optional explicit policy + injected deps (env/fetch/email rail).
 * @returns One result per attempted transport.
 */
export async function notifyBySeverity(
  severity: NotifySeverity,
  message: NotificationMessage,
  opts: { policy?: SeverityPolicy; deps?: TransportDeps } = {},
): Promise<NotificationResult[]> {
  const kinds = transportsForSeverity(severity, opts);
  if (kinds.length === 0) {
    logger.info({ severity }, 'notifyBySeverity: no configured transport for this severity — nothing sent');
    return [{ delivered: false, skipped: true, transport: 'noop', error: 'no_transport_for_severity' }];
  }
  logger.info({ severity, kinds }, 'notifyBySeverity routing');
  return notifyAll(message, { kinds, deps: opts.deps });
}
