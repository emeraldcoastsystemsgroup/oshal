/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the SMS channel adapter (SMS_CHANNEL_PROVIDER, normalizeE164, parseSmsLinkCommand, boundSmsReply): inbound Twilio SMS binds a phone number to a user through the SAME channel_links identity store Telegram uses, so one shared number serves many users without a number ever reaching another user's swarm.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — barrel for the chat-channels feature slice (Telegram inbound surface; OpenClaw-parity "message your swarm" channel). Services only depend on @/shared; the dispatch orchestration that needs AppContext + the accountable bot lives in the app-layer route (chat-channel-routes.ts) to respect FSD layer direction.
 */

export { ChannelLinkService, type ChannelLink } from './services/channel-link-service';
export {
  type InboundChannelMessage,
  getTelegramBotToken,
  deriveWebhookSecret,
  verifyWebhookSecret,
  parseTelegramUpdate,
  sendTelegramMessage,
  sendTelegramTyping,
  registerTelegramWebhook,
  getTelegramBotIdentity,
} from './services/telegram-channel-adapter';
export {
  SMS_CHANNEL_PROVIDER,
  WHATSAPP_CHANNEL_PROVIDER,
  parseTwilioChannelAddress,
  type TwilioChannelProvider,
  SMS_REPLY_MAX_CHARS,
  normalizeE164,
  parseSmsLinkCommand,
  boundSmsReply,
} from './services/sms-channel-adapter';
