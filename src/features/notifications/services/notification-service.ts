/**
 * Notifications — the transport registry + operator-notify convenience.
 *
 * Selects a `NotificationTransport` by kind (explicit, or `NOTIFY_TRANSPORT` env, default `telegram`)
 * and exposes `notifyOperator(message)` — the one call other features use (trading watchdog, creative
 * studio delivery, failed overnight jobs) without knowing which channel is wired. Adding a vendor is a
 * new class + one registry entry; callers never change. A `noop` transport is always available so the
 * service is safe to call even with nothing configured (returns a `skipped` result).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — resolveTransport() by kind/env + notifyOperator() over the default, with a no-op fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Registered the EmailTransport ('email') so the severity policy + fan-out can route to an inbox over the injected connector rail (configured only when deps.email is provided — env-only deployments never see it).
 *
 * @module features/notifications/services/notification-service
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps, TransportKind } from '../types';
import { TelegramTransport } from './telegram-transport';
import { TwilioSmsTransport } from './twilio-sms-transport';
import { TwilioVoiceTransport } from './twilio-voice-transport';
import { TwilioWhatsAppTransport } from './twilio-whatsapp-transport';
import { EmailTransport } from './email-transport';

const logger = createChildLogger({ module: 'notifications' });

/** The always-available transport: delivers nothing, reports skipped. Keeps callers null-safe. */
class NoopTransport implements NotificationTransport {
  readonly kind = 'noop' as const;
  configured(): boolean { return true; }
  async send(): Promise<NotificationResult> {
    return { delivered: false, skipped: true, transport: this.kind, error: 'no_transport_configured' };
  }
}

/** Registry of transport factories. Add a sibling (e.g. twilio-sms) with one entry — callers unchanged. */
const REGISTRY: Partial<Record<TransportKind, (deps: TransportDeps) => NotificationTransport>> = {
  telegram: (deps) => new TelegramTransport(deps),
  'twilio-sms': (deps) => new TwilioSmsTransport(deps),
  'twilio-voice': (deps) => new TwilioVoiceTransport(deps),
  'twilio-whatsapp': (deps) => new TwilioWhatsAppTransport(deps),
  email: (deps) => new EmailTransport(deps),
  noop: () => new NoopTransport(),
};

/** The configured default transport kind (NOTIFY_TRANSPORT), or 'telegram'. */
export function defaultTransportKind(env: NodeJS.ProcessEnv = process.env): TransportKind {
  const raw = (env.NOTIFY_TRANSPORT || 'telegram').trim().toLowerCase();
  return (raw in REGISTRY ? raw : 'telegram') as TransportKind;
}

/**
 * @description Resolve a transport instance by explicit kind, else the configured default. An unknown
 * kind resolves to the no-op transport rather than throwing.
 * @param kind - Optional explicit transport kind.
 * @param deps - Injected fetch/env (for tests).
 * @returns A transport instance (never null).
 */
export function resolveTransport(kind?: TransportKind, deps: TransportDeps = {}): NotificationTransport {
  const selected = kind ?? defaultTransportKind(deps.env);
  const factory = REGISTRY[selected] ?? REGISTRY.noop!;
  return factory(deps);
}

/**
 * @description Send one notification over the resolved transport. The single entry point for
 * platform-wide operator alerts. Never throws; an unconfigured transport returns a `skipped` result.
 * @param message - The notification (text + optional media).
 * @param opts - Optional explicit transport kind + injected deps.
 * @returns The delivery result.
 */
export async function notifyOperator(
  message: NotificationMessage,
  opts: { kind?: TransportKind; deps?: TransportDeps } = {},
): Promise<NotificationResult> {
  const transport = resolveTransport(opts.kind, opts.deps ?? {});
  if (!transport.configured()) {
    logger.debug({ transport: transport.kind }, 'notifyOperator: transport not configured — skipping');
    return { delivered: false, skipped: true, transport: transport.kind, error: `${transport.kind}_not_configured` };
  }
  const result = await transport.send(message);
  logger.info({ transport: result.transport, delivered: result.delivered, fellBackToLink: result.fellBackToLink, skipped: result.skipped }, 'notifyOperator complete');
  return result;
}

/**
 * @description Every non-noop transport kind whose credentials/config are fully present right now —
 * i.e. the channels a fan-out would actually reach. Order follows the registry declaration.
 * @param deps - Injected fetch/env (for tests).
 * @returns The configured transport kinds (possibly empty).
 */
export function configuredTransportKinds(deps: TransportDeps = {}): TransportKind[] {
  return (Object.keys(REGISTRY) as TransportKind[])
    .filter((k) => k !== 'noop')
    .filter((k) => REGISTRY[k]!(deps).configured());
}

/**
 * @description Fan one notification across multiple transports concurrently — the millionaire-alarm
 * "text me AND call me AND WhatsApp me" leg. With no explicit `kinds`, it targets every currently
 * configured transport; with explicit `kinds`, it targets exactly those (an unconfigured one returns a
 * `skipped` result, not an error). Never throws — every send resolves to its own result. When nothing
 * is configured/requested it returns a single `skipped` noop result so callers see an explicit outcome.
 * @param message - The notification (text + optional media).
 * @param opts - Optional explicit transport kinds + injected deps.
 * @returns One result per attempted transport.
 */
export async function notifyAll(
  message: NotificationMessage,
  opts: { kinds?: TransportKind[]; deps?: TransportDeps } = {},
): Promise<NotificationResult[]> {
  const deps = opts.deps ?? {};
  const kinds = [...new Set(opts.kinds ?? configuredTransportKinds(deps))];
  if (kinds.length === 0) {
    logger.debug('notifyAll: no configured/requested transports — nothing sent');
    return [{ delivered: false, skipped: true, transport: 'noop', error: 'no_transport_configured' }];
  }
  const results = await Promise.all(kinds.map((kind) => notifyOperator(message, { kind, deps })));
  logger.info({ attempted: kinds.length, delivered: results.filter((r) => r.delivered).length }, 'notifyAll complete');
  return results;
}
