/**
 * Chat-channel routes — "message your swarm on Telegram" (the OpenClaw-parity ambient surface).
 *
 * An inbound Telegram message is NOT a new brain: it resolves to the OSHAL user who linked that
 * chat, then runs on the same accountable Jarvis bot the cockpit uses (BotNodeClient.execute →
 * cost captured in chat_tasks, ADR-036/050). The controller only does channel I/O — it never
 * calls an LLM itself.
 *
 * Auth model (CLAUDE.md — auth is opt-in per route):
 *  - POST /telegram/webhook/:secret  → PUBLIC (Telegram posts here unauthenticated; authenticity is
 *    enforced by the derived secret in both the header and the path).
 *  - everything else (link / list / unlink / register-webhook) → requiresAuth-gated.
 *
 * Isolation: the (provider, channel_user_id) → user_sub binding is the boundary. A shared demo bot
 * routes each DM to the correct linked user via ChannelLinkService; an unlinked chat gets linking
 * instructions, never another user's data.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Telegram inbound channel: public webhook (secret-verified) → link resolution / one-time-code linking → dispatch to the Jarvis bot → reply in-channel; plus auth-gated link/list/unlink/register-webhook endpoints for the cockpit Channels card.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: stop forwarding connector credentials into the Jarvis/model request; retain exact linked-owner identity and BYO inference selection only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SMS is a second channel on the same identity store: mint/unlink endpoints for provider 'sms'. The inbound webhook (POST /api/sms/inbound) redeems the minted code when the user texts LINK <code>, which is the SMS equivalent of Telegram's /start deep link — without a way to MINT one, the caller-scoped inbound dispatch had no binding to resolve. The number is normalized on both sides so one phone cannot become two identities.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The two replies an unlinked chat gets — the greeting and the linking prompt — name the product as it is called today. They were the retired standalone form, and they are the only product name a Telegram user ever sees, read before that person has any other context for what they are talking to.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Denial audit and real-boundary seams. Every refusal on Telegram and Discord (unlinked sender; invalid, expired or other-provider code; identity already bound to another user) is recorded in the refusal ledger through recordChannelRefusal - the Telegram unlinked path previously did not even log. The Telegram handler is exported as processTelegramInbound beside processDiscordInbound, both on one ChannelInboundLinkPort with optional audit/typing hooks, and a refused cross-user rebind gets its own reply instead of 'invalid code'. createChatChannelRoutes takes optional dispatch/provider-send/Gateway seams so the real webhook and the real Gateway protocol can be driven end to end against a real Postgres without a bot node or a provider account; production passes none. WhatsApp: the link mint advertises TWILIO_WHATSAPP_FROM (the sender the user actually messages) when set, and GET / reports the whatsapp configured state.
 *
 * @module chat-channel-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import {
  ChannelLinkService,
  DISCORD_CHANNEL_PROVIDER,
  SMS_CHANNEL_PROVIDER,
  WHATSAPP_CHANNEL_PROVIDER,
  parseSmsLinkCommand,
  normalizeE164,
  recordChannelRefusal,
  redeemChannelCode,
  type ChannelLinkRedeemer,
  type ChannelRefusalRecorder,
  type InboundChannelMessage,
  getTelegramBotToken,
  deriveWebhookSecret,
  verifyWebhookSecret,
  parseTelegramUpdate,
  sendTelegramMessage,
  sendTelegramTyping,
  registerTelegramWebhook,
  getTelegramBotIdentity,
  getDiscordBotToken,
  sendDiscordMessage,
  startDiscordGateway,
  type DiscordGatewayOptions,
  type InboundDiscordMessage,
} from '@/features/chat-channels';
import { executeBotOrInline } from './inline-bot-execution';
import { resolveUserLlmConnection } from './free-tier-rotation';

const logger = createChildLogger({ module: 'chat-channel-routes' });

/** The unified assistant bot — the accountable brain every channel message runs on (ADR-050). */
const JARVIS_AGENT_ID = 'a0000000-0000-0000-0000-000000000050';

const botClient = new BotNodeClient(createRegistryEndpointResolver());

/** Signed-in caller's OIDC sub. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

/**
 * @description Runs one channel message on the accountable Jarvis bot, threading the linked user's
 * sub + their own LLM endpoint so owner scoping and cost capture apply. Connector credentials
 * remain inside audited server-side operations and never enter this model-visible request.
 *
 * IDENTITY (double-check 2026-07-08): the webhook request is unauthenticated, so the ambient
 * AsyncLocalStorage identity is ANONYMOUS (sub='') — under FORCE RLS, oshal_connections returns
 * zero rows and the BYO resolver silently returns no endpoint. Re-enter the
 * LINKED user's identity for the whole dispatch — scoped to exactly that user, never operator.
 *
 * TASK CONTINUITY: the taskId is stable PER CHAT (not per message) so follow-up questions land
 * in the same conversation context — the cockpit Jarvis surface threads a session id the same way.
 * @returns The bot's reply text (never empty).
 */
async function dispatchToSwarm(ctx: AppContext, provider: string, sub: string, chatId: string, text: string): Promise<string> {
  return runWithRequestIdentity({ sub, isOperator: false }, async () => {
    const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, sub);
    const taskId = `${provider}-${sub}-${chatId}`;
    const result = await executeBotOrInline(ctx, botClient, JARVIS_AGENT_ID, {
      text,
      taskId,
      workspaceFolderId: taskId,
      agentId: JARVIS_AGENT_ID,
      agenticMode: true,
      direct: true,
      userSub: sub,
      byoLlmConnection,
    });
    return String(result.response || '').trim() || '(no reply)';
  });
}

/** The link-store surface the inbound processors use; ChannelLinkService satisfies it. */
export interface ChannelInboundLinkPort extends ChannelLinkRedeemer {
  resolveLink(provider: string, channelUserId: string): Promise<{ userSub: string } | null>;
  claimInboundMessage(userSub: string, provider: string, eventId: string): Promise<boolean>;
}

/** Optional collaborators of an inbound processor: the refusal recorder and a typing indicator. */
export interface ChannelInboundHooks {
  /** Records a refusal; the platform refusal ledger by default. */
  audit?: ChannelRefusalRecorder;
  /** Best-effort "working on it" signal sent before a bot turn. */
  typing?: (chatId: string) => Promise<void>;
}

/** What a Telegram sender is told on each link/refusal outcome. */
export const TELEGRAM_CHANNEL_REPLIES = Object.freeze({
  welcome: 'Welcome to oshal. To connect this chat to your account, open your cockpit → Channels → Connect Telegram and tap the link.',
  linked: '✅ Connected. You can now message your swarm right here — ask it anything your apps can do.',
  invalid: 'That link code is invalid or expired. Generate a fresh one in your cockpit → Channels → Connect Telegram.',
  rebind: 'This chat is already connected to a different oshal account. Unlink it from that account first, then use a fresh link.',
  unlinked: 'This chat isn\'t linked to an oshal account yet. Open your cockpit → Channels → Connect Telegram to get a one-time link.',
});
/** What a Discord DM sender is told on each link/refusal outcome. */
export const DISCORD_CHANNEL_REPLIES = Object.freeze({
  linked: 'Connected. You can now message your swarm from this DM.',
  invalid: 'That link code is invalid or expired. Generate a fresh one in your cockpit under Channels.',
  rebind: 'This Discord account is already connected to a different oshal account. Unlink it from that account first, then send a fresh code.',
  unlinked: 'This DM is not linked to an oshal account yet. Open your cockpit → Channels → Connect Discord to get a one-time link.',
});
const FAILED_TURN_REPLY = 'Something went wrong reaching your swarm. Please try again in a moment.';

/** Run a linked message's bot turn as its owner (never operator), whatever the ambient webhook identity. */
function asOwner<T>(ownerSub: string, work: () => Promise<T>): Promise<T> {
  return runWithRequestIdentity({ sub: ownerSub, isOperator: false }, work);
}

/**
 * @description Handles one normalized Telegram message: the `/start <code>` linking handshake, the
 * audited refusal of an unlinked chat, or a single owner-bound dispatch with its in-chat reply.
 * Runs AFTER the webhook has already 200'd, so a slow bot turn never makes Telegram retry.
 * @param links - The channel identity store.
 * @param msg - The parsed private-chat update.
 * @param dispatch - Runs the message on the linked owner's accountable bot.
 * @param send - Sends a reply to the chat.
 * @param hooks - Refusal recorder and typing indicator.
 * @returns Nothing; every outcome is a reply (or a silent duplicate).
 */
export async function processTelegramInbound(
  links: ChannelInboundLinkPort,
  msg: InboundChannelMessage,
  dispatch: (ownerSub: string, message: InboundChannelMessage) => Promise<string>,
  send: (chatId: string, text: string) => Promise<void>,
  hooks: ChannelInboundHooks = {},
): Promise<void> {
  const audit = hooks.audit ?? recordChannelRefusal;
  const start = msg.text.match(/^\/start(?:\s+(\S+))?/i);
  if (start) {
    if (!start[1]) { await send(msg.chatId, TELEGRAM_CHANNEL_REPLIES.welcome); return; }
    const outcome = await redeemChannelCode(links, { provider: msg.provider, code: start[1], channelUserId: msg.channelUserId,
      chatId: msg.chatId, displayName: msg.displayName, eventId: msg.eventId }, audit);
    await send(msg.chatId, outcome.status === 'linked' ? TELEGRAM_CHANNEL_REPLIES.linked
      : outcome.status === 'bound_to_another_user' ? TELEGRAM_CHANNEL_REPLIES.rebind : TELEGRAM_CHANNEL_REPLIES.invalid);
    return;
  }
  const link = await links.resolveLink(msg.provider, msg.channelUserId);
  if (!link) {
    await audit({ provider: msg.provider, channelUserId: msg.channelUserId, reason: 'unlinked_identity', eventId: msg.eventId });
    await send(msg.chatId, TELEGRAM_CHANNEL_REPLIES.unlinked);
    return;
  }
  if (!await links.claimInboundMessage(link.userSub, msg.provider, msg.eventId)) return;
  await hooks.typing?.(msg.chatId);
  try {
    await send(msg.chatId, await asOwner(link.userSub, () => dispatch(link.userSub, msg)));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, provider: msg.provider }, 'channel dispatch failed');
    await send(msg.chatId, FAILED_TURN_REPLY);
  }
}

/**
 * @description Handles one Discord DM: `LINK <code>` redemption, the audited refusal of an unlinked
 * sender, or a single owner-bound dispatch with its in-DM reply.
 * @param links - The channel identity store.
 * @param msg - The parsed DM (guild and group traffic never reaches here).
 * @param dispatch - Runs the message on the linked owner's accountable bot.
 * @param send - Sends a reply to the DM channel.
 * @param hooks - Refusal recorder.
 * @returns Nothing; every outcome is a reply (or a silent duplicate).
 */
export async function processDiscordInbound(
  links: ChannelInboundLinkPort,
  msg: InboundDiscordMessage,
  dispatch: (ownerSub: string, message: InboundDiscordMessage) => Promise<string>,
  send: (channelId: string, text: string) => Promise<void>,
  hooks: ChannelInboundHooks = {},
): Promise<void> {
  const audit = hooks.audit ?? recordChannelRefusal;
  const code = parseSmsLinkCommand(msg.text);
  if (code) {
    const outcome = await redeemChannelCode(links, { provider: DISCORD_CHANNEL_PROVIDER, code, channelUserId: msg.channelUserId,
      chatId: msg.channelId, displayName: msg.displayName, eventId: msg.eventId }, audit);
    await send(msg.channelId, outcome.status === 'linked' ? DISCORD_CHANNEL_REPLIES.linked
      : outcome.status === 'bound_to_another_user' ? DISCORD_CHANNEL_REPLIES.rebind : DISCORD_CHANNEL_REPLIES.invalid);
    return;
  }
  const link = await links.resolveLink(DISCORD_CHANNEL_PROVIDER, msg.channelUserId);
  if (!link) {
    await audit({ provider: DISCORD_CHANNEL_PROVIDER, channelUserId: msg.channelUserId, reason: 'unlinked_identity', eventId: msg.eventId });
    await send(msg.channelId, DISCORD_CHANNEL_REPLIES.unlinked);
    return;
  }
  if (!await links.claimInboundMessage(link.userSub, msg.provider, msg.eventId)) return;
  try {
    await send(msg.channelId, await asOwner(link.userSub, () => dispatch(link.userSub, msg)));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, provider: msg.provider }, 'Discord DM dispatch failed');
    await send(msg.channelId, FAILED_TURN_REPLY);
  }
}

/**
 * The seams a spec or Test Lab replaces: the accountable bot turn and the provider sends. Production
 * passes nothing and gets the Jarvis dispatch plus the real Telegram/Discord APIs.
 */
export interface ChatChannelRouteDeps {
  /** Runs one linked message on the owner's accountable bot (default: Jarvis via executeBotOrInline). */
  dispatch?: (provider: string, ownerSub: string, chatId: string, text: string) => Promise<string>;
  /** Telegram reply + typing (default: the Bot API). */
  telegram?: { send(chatId: string, text: string): Promise<void>; typing?(chatId: string): Promise<void> };
  /** Discord reply (default: the REST API) and Gateway options (default: the configured token). */
  discord?: { send?(channelId: string, text: string): Promise<void>; gateway?: DiscordGatewayOptions };
}

/**
 * @description The public Telegram webhook: verify the derived secret header, acknowledge at once,
 * then process the update off the request.
 */
function telegramWebhook(
  links: ChannelLinkService,
  dispatch: NonNullable<ChatChannelRouteDeps['dispatch']>,
  telegram: NonNullable<ChatChannelRouteDeps['telegram']>,
): RequestHandler {
  // ── PUBLIC: Telegram delivers updates here ────────────────────────────────
  // FIXED PATH, secret in the HEADER ONLY (double-check 2026-07-08): the secret used to
  // double as a URL path segment, which persisted it to container logs and the append-only
  // access_audit_log on EVERY delivery — one unredactable copy per message, and it was the
  // only credential guarding the endpoint. Telegram's secret_token header (returned on every
  // delivery, constant-time verified below) is the designed authenticity mechanism.
  return (req: Request, res: Response) => {
    const token = getTelegramBotToken();
    if (!token) { res.sendStatus(503); return; }
    const expected = deriveWebhookSecret(token);
    const headerSecret = req.header('x-telegram-bot-api-secret-token');
    if (!verifyWebhookSecret(headerSecret, expected)) {
      logger.warn('telegram webhook secret mismatch — rejected');
      res.sendStatus(401);
      return;
    }
    // Acknowledge immediately; the durable event claim suppresses provider retries and a slow turn.
    res.sendStatus(200);
    const msg = parseTelegramUpdate(req.body);
    if (!msg) return;
    void processTelegramInbound(links, msg, (ownerSub, m) => dispatch(m.provider, ownerSub, m.chatId, m.text),
      (chatId, text) => telegram.send(chatId, text), { typing: telegram.typing })
      .catch((err) => logger.error({ err, stack: (err as Error).stack }, 'telegram inbound handling failed'));
  };
}

/**
 * @description Builds the chat-channel router. Mounted at /api/channels WITHOUT a blanket auth guard
 * so the public webhook is reachable; user-facing endpoints apply requiresAuth individually.
 * @param ctx - App context (Postgres pool, orchestrator).
 * @param requiresAuth - The OIDC route guard, applied to the user-facing endpoints only.
 * @param deps - Optional dispatch/provider seams; production omits them.
 * @returns The configured Express router.
 */
export function createChatChannelRoutes(ctx: AppContext, requiresAuth: RequestHandler, deps: ChatChannelRouteDeps = {}): Router {
  const router = Router();
  const links = new ChannelLinkService(ctx.pool as never);
  void links.ensureSchema();
  const dispatch = deps.dispatch ?? ((provider, sub, chatId, text) => dispatchToSwarm(ctx, provider, sub, chatId, text));
  const telegram = deps.telegram ?? { send: sendTelegramMessage, typing: sendTelegramTyping };
  const discordSend = deps.discord?.send ?? ((channelId: string, text: string) => sendDiscordMessage(channelId, text));
  startDiscordGateway((message) => processDiscordInbound(
    links, message, (ownerSub, m) => dispatch(m.provider, ownerSub, m.channelId, m.text), discordSend,
  ), deps.discord?.gateway);

  // ── PUBLIC: Telegram delivers updates here (secret-header verified) ─────────
  router.post('/telegram/webhook', telegramWebhook(links, dispatch, telegram));

  // ── AUTH-GATED: the cockpit "Channels" card ───────────────────────────────
  router.get('/', requiresAuth, (req, res) => void listChannels(links, req, res));
  router.post('/telegram/link', requiresAuth, (req, res) => void mintTelegramLink(links, req, res));
  router.delete('/telegram/:channelUserId', requiresAuth, (req, res) => void unlinkChannel(links, req, res));
  router.post('/telegram/register-webhook', requiresAuth, (req, res) => void doRegisterWebhook(req, res));
  router.post('/sms/link', requiresAuth, (req, res) => void mintSmsLink(links, req, res));
  router.delete('/sms/:channelUserId', requiresAuth, (req, res) => void unlinkSms(links, req, res));
  router.post('/whatsapp/link', requiresAuth, (req, res) => void mintWhatsAppLink(links, req, res));
  router.delete('/whatsapp/:channelUserId', requiresAuth, (req, res) => void unlinkWhatsApp(links, req, res));
  router.post('/discord/link', requiresAuth, (req, res) => void mintDiscordLink(links, req, res));
  router.delete('/discord/:channelUserId', requiresAuth, (req, res) => void unlinkDiscord(links, req, res));

  return router;
}

/** The shared deployment number a texter sends their LINK code to (empty when SMS isn't wired). */
function inboundSmsNumber(): string {
  return (process.env.TWILIO_INBOUND_NUMBER || process.env.TWILIO_FROM_NUMBER || '').trim();
}

/**
 * The WhatsApp sender a user messages: the deployment's WhatsApp-enabled sender when configured,
 * otherwise the inbound SMS number (one Twilio number can carry both). Always bare E.164.
 */
function whatsAppSenderNumber(): string {
  const configured = (process.env.TWILIO_WHATSAPP_FROM || '').trim().replace(/^whatsapp:/i, '');
  return configured || inboundSmsNumber();
}

/** POST /sms/link — mint a one-time code plus the number to text it to. */
async function mintSmsLink(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const textTo = inboundSmsNumber();
  if (!textTo) { res.status(503).json({ error: 'sms_not_configured' }); return; }
  const code = await links.mintLinkCode(sub, SMS_CHANNEL_PROVIDER);
  res.json({ code, textTo, message: `LINK ${code}`, expiresInMinutes: 15 });
}

/** DELETE /sms/:channelUserId — unlink one of the caller's own numbers (owner-scoped). */
async function unlinkSms(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const number = normalizeE164(String(req.params.channelUserId || ''));
  if (!number) { res.status(400).json({ error: 'invalid_phone_number' }); return; }
  res.json({ removed: await links.unlink(sub, SMS_CHANNEL_PROVIDER, number) });
}

/** POST /whatsapp/link — mint a one-time code plus the WhatsApp sender to message it to. */
async function mintWhatsAppLink(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const textTo = whatsAppSenderNumber();
  if (!textTo) { res.status(503).json({ error: 'whatsapp_not_configured' }); return; }
  const code = await links.mintLinkCode(sub, WHATSAPP_CHANNEL_PROVIDER);
  res.json({ code, textTo: `whatsapp:${textTo}`, message: `LINK ${code}`, expiresInMinutes: 15 });
}

async function unlinkWhatsApp(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const number = normalizeE164(String(req.params.channelUserId || ''));
  if (!number) { res.status(400).json({ error: 'invalid_phone_number' }); return; }
  res.json({ removed: await links.unlink(sub, WHATSAPP_CHANNEL_PROVIDER, number) });
}

async function mintDiscordLink(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  if (!getDiscordBotToken()) { res.status(503).json({ error: 'discord_not_configured' }); return; }
  const code = await links.mintLinkCode(sub, DISCORD_CHANNEL_PROVIDER);
  res.json({ code, message: `DM the Discord bot: LINK ${code}`, expiresInMinutes: 15 });
}

async function unlinkDiscord(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const channelUserId = String(req.params.channelUserId || '').trim();
  if (!/^\d{5,30}$/.test(channelUserId)) { res.status(400).json({ error: 'invalid_discord_user_id' }); return; }
  res.json({ removed: await links.unlink(sub, DISCORD_CHANNEL_PROVIDER, channelUserId) });
}

/** GET / — the caller's linked channels + per-provider setup state (Telegram bot, SMS/WhatsApp numbers, Discord token presence). */
async function listChannels(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const identity = await getTelegramBotIdentity();
  res.json({
    telegram: { configured: Boolean(getTelegramBotToken()), bot: identity },
    sms: { configured: Boolean(inboundSmsNumber()), number: inboundSmsNumber() || null },
    whatsapp: { configured: Boolean(whatsAppSenderNumber()), number: whatsAppSenderNumber() ? `whatsapp:${whatsAppSenderNumber()}` : null },
    discord: { configured: Boolean(getDiscordBotToken()) },
    links: await links.listLinks(sub),
  });
}

/** POST /telegram/link — mint a one-time code and the t.me deep link the user taps to connect. */
async function mintTelegramLink(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const identity = await getTelegramBotIdentity();
  if (!identity) { res.status(503).json({ error: 'telegram_not_configured' }); return; }
  const code = await links.mintLinkCode(sub, 'telegram');
  res.json({
    code,
    botUsername: identity.username,
    deepLink: `https://t.me/${identity.username}?start=${code}`,
    expiresInMinutes: 15,
  });
}

/** DELETE /telegram/:channelUserId — unlink one of the caller's own channels. */
async function unlinkChannel(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const removed = await links.unlink(sub, 'telegram', String(req.params.channelUserId));
  res.json({ removed });
}

/** POST /telegram/register-webhook — (re)point Telegram at this deployment. Body: { baseUrl? }. */
async function doRegisterWebhook(req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const baseUrl = String((req.body as { baseUrl?: string })?.baseUrl || process.env.APP_URL || '').trim();
  if (!baseUrl) { res.status(400).json({ error: 'missing_base_url' }); return; }
  try {
    const webhookUrl = await registerTelegramWebhook(baseUrl);
    res.json({ ok: true, webhookUrl });
  } catch (err) {
    logger.error({ err }, 'register telegram webhook failed');
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
}
