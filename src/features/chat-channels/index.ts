/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the SMS channel adapter (SMS_CHANNEL_PROVIDER, normalizeE164, parseSmsLinkCommand, boundSmsReply): inbound Twilio SMS binds a phone number to a user through the SAME channel_links identity store Telegram uses, so one shared number serves many users without a number ever reaching another user's swarm.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — barrel for the chat-channels feature slice (Telegram inbound surface; OpenClaw-parity "message your swarm" channel). Services only depend on @/shared; the dispatch orchestration that needs AppContext + the accountable bot lives in the app-layer route (chat-channel-routes.ts) to respect FSD layer direction.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the channel denial audit (recordChannelRefusal, channelRefusalActor, CHANNEL_REFUSAL_CODES) and the ChannelLinkRedemption outcome so every inbound provider records unlinked, bad-code and cross-user-rebind refusals the same way.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export the operator-level Discord setup pieces: the encrypted provider settings store, live bot-token validation with the invite/DM URL builders, the Gateway supervisor (start/stop in process) and the DiscordChannelConfig that applies the boot precedence and serves both cockpit cards. The Gateway status type rides along so the app layer can name a refusal.
 */

export { ChannelLinkService, type ChannelLink, type ChannelLinkRedemption } from './services/channel-link-service';
export {
  CHANNEL_REFUSAL_CODES,
  CHANNEL_REFUSAL_PACKAGE,
  channelRefusalActor,
  recordChannelRefusal,
  redeemChannelCode,
  type ChannelLinkAttempt,
  type ChannelLinkRedeemer,
  type ChannelRefusalInput,
  type ChannelRefusalReason,
  type ChannelRefusalRecorder,
} from './services/channel-refusal-audit';
export {
  DISCORD_API_BASE,
  DISCORD_CHANNEL_PROVIDER,
  getDiscordBotToken,
  parseDiscordGatewayMessage,
  sendDiscordMessage,
  startDiscordGateway,
  type DiscordGatewayHandle,
  type DiscordGatewayOptions,
  type DiscordGatewayStatus,
  type InboundDiscordMessage,
} from './services/discord-channel-adapter';
export { ChannelProviderSettingsStore, type ChannelProviderSettings, type ProviderSecretCipher } from './services/channel-provider-settings';
export {
  DISCORD_FLAG_MESSAGE_CONTENT,
  DISCORD_FLAG_MESSAGE_CONTENT_LIMITED,
  DiscordTokenValidationError,
  discordDmUrl,
  discordInviteUrl,
  validateDiscordBotToken,
  type DiscordBotIdentity,
  type DiscordIdentityOptions,
  type DiscordTokenValidationCode,
} from './services/discord-bot-identity';
export { DiscordGatewaySupervisor, type DiscordSupervisorStatus, type DiscordTokenSource } from './services/discord-gateway-supervisor';
export { DiscordChannelConfig, type DiscordChannelConfigOptions, type DiscordChannelState } from './services/discord-channel-config';
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
