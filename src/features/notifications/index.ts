/**
 * Notifications feature — barrel (FSD).
 *
 * The pluggable outbound-notification harness: `import { notifyOperator } from '@/features/notifications'`
 * to push an alert over whichever channel is configured (Telegram today; Twilio siblings next), the
 * same pluggable-provider discipline used for LLM providers + TTS.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the notification transport harness.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preference center: export the per-user prefs store (user_notification_prefs) + quiet-hours math + the per-user NotificationRouter (injected senders; operator transports unchanged).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the EmailTransport, the severity → transport policy (NotifySeverity/notifyBySeverity/transportsForSeverity/DEFAULT_SEVERITY_POLICY), and the inbound-SMS parse + Twilio-signature verification helpers.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export the platform-credential SMTP mailer (smtpConfigured/sendTransactionalMail) — the variable-recipient transactional sibling the invite flow needs (ADR-117); the OAuth EmailTransport rail stays the fixed-destination operator path.
 *
 * @module features/notifications
 */

export * from './types';
export { TelegramTransport, TELEGRAM_MAX_INLINE_BYTES } from './services/telegram-transport';
export { TwilioSmsTransport } from './services/twilio-sms-transport';
export { TwilioVoiceTransport, xmlEscape } from './services/twilio-voice-transport';
export { TwilioWhatsAppTransport, whatsAppAddr } from './services/twilio-whatsapp-transport';
export { EmailTransport } from './services/email-transport';
export { smtpConfigured, sendTransactionalMail } from './services/smtp-mailer';
export type { TransactionalMail, MailSendResult } from './services/smtp-mailer';
export { notifyOperator, notifyAll, configuredTransportKinds, resolveTransport, defaultTransportKind } from './services/notification-service';
export {
  NOTIFY_SEVERITIES,
  DEFAULT_SEVERITY_POLICY,
  severityPolicyFromEnv,
  transportsForSeverity,
  notifyBySeverity,
} from './services/notification-policy';
export type { NotifySeverity, SeverityPolicy } from './services/notification-policy';
export {
  parseTwilioInboundSms,
  verifyTwilioSignature,
  twilioSignatureBase,
  flattenFormParams,
} from './services/inbound-sms';
export type { InboundSms, RawFormValue } from './services/inbound-sms';
export { NOTIFY_CHANNELS, readUserPref, listUserPrefs, upsertUserPref, hourInTimeZone, isQuietHours } from './services/notification-prefs';
export type { NotifyChannel, PgLike, UserNotificationPref } from './services/notification-prefs';
export { NotificationRouter } from './services/notification-router';
export type { UserNotifyMessage, NotifyOutcome, UserChannelSender, NotificationRouterDeps } from './services/notification-router';
