/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
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
