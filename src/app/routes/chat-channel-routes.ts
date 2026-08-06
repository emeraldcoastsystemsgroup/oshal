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
  type InboundChannelMessage,
  getTelegramBotToken,
  deriveWebhookSecret,
  verifyWebhookSecret,
  parseTelegramUpdate,
  sendTelegramMessage,
  sendTelegramTyping,
  registerTelegramWebhook,
  getTelegramBotIdentity,
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
async function dispatchToSwarm(ctx: AppContext, sub: string, chatId: string, text: string): Promise<string> {
  return runWithRequestIdentity({ sub, isOperator: false }, async () => {
    const byoLlmConnection = await resolveUserLlmConnection(ctx.pool, sub);
    const taskId = `telegram-${sub}-${chatId}`;
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

/**
 * @description Handles one normalized inbound message: the `/start <code>` linking handshake, the
 * unlinked-chat guidance, or a real dispatch to the swarm. Sends the reply back on the channel.
 * Runs AFTER the webhook has already 200'd, so a slow bot turn never makes Telegram retry.
 */
async function handleInbound(ctx: AppContext, links: ChannelLinkService, msg: InboundChannelMessage): Promise<void> {
  const start = msg.text.match(/^\/start(?:\s+(\S+))?/i);
  if (start) {
    await handleStart(links, msg, start[1]);
    return;
  }
  const link = await links.resolveLink(msg.provider, msg.channelUserId);
  if (!link) {
    await sendTelegramMessage(msg.chatId,
      'This chat isn\'t linked to an Open Swarm account yet. Open your cockpit → Channels → Connect Telegram to get a one-time link.');
    return;
  }
  await sendTelegramTyping(msg.chatId);
  try {
    const reply = await dispatchToSwarm(ctx, link.userSub, msg.chatId, msg.text);
    await sendTelegramMessage(msg.chatId, reply);
  } catch (err) {
    logger.error({ err, provider: msg.provider }, 'channel dispatch failed');
    await sendTelegramMessage(msg.chatId, 'Something went wrong reaching your swarm. Please try again in a moment.');
  }
}

/** @description The linking handshake: redeem a `/start <code>` deep-link code, or greet+instruct. */
async function handleStart(links: ChannelLinkService, msg: InboundChannelMessage, code?: string): Promise<void> {
  if (!code) {
    await sendTelegramMessage(msg.chatId,
      'Welcome to Open Swarm. To connect this chat to your account, open your cockpit → Channels → Connect Telegram and tap the link.');
    return;
  }
  const sub = await links.redeemLinkCode(msg.provider, code, msg.channelUserId, msg.chatId, msg.displayName);
  await sendTelegramMessage(msg.chatId, sub
    ? '✅ Connected. You can now message your swarm right here — ask it anything your apps can do.'
    : 'That link code is invalid or expired. Generate a fresh one in your cockpit → Channels → Connect Telegram.');
}

/**
 * @description Builds the chat-channel router. Mounted at /api/channels WITHOUT a blanket auth guard
 * so the public webhook is reachable; user-facing endpoints apply requiresAuth individually.
 * @param ctx - App context (Postgres pool, orchestrator).
 * @param requiresAuth - The OIDC route guard, applied to the user-facing endpoints only.
 * @returns The configured Express router.
 */
export function createChatChannelRoutes(ctx: AppContext, requiresAuth: RequestHandler): Router {
  const router = Router();
  const links = new ChannelLinkService(ctx.pool as never);
  void links.ensureSchema();

  // ── PUBLIC: Telegram delivers updates here ────────────────────────────────
  // FIXED PATH, secret in the HEADER ONLY (double-check 2026-07-08): the secret used to
  // double as a URL path segment, which persisted it to container logs and the append-only
  // access_audit_log on EVERY delivery — one unredactable copy per message, and it was the
  // only credential guarding the endpoint. Telegram's secret_token header (returned on every
  // delivery, constant-time verified below) is the designed authenticity mechanism.
  router.post('/telegram/webhook', (req: Request, res: Response) => {
    const token = getTelegramBotToken();
    if (!token) { res.sendStatus(503); return; }
    const expected = deriveWebhookSecret(token);
    const headerSecret = req.header('x-telegram-bot-api-secret-token');
    if (!verifyWebhookSecret(headerSecret, expected)) {
      logger.warn('telegram webhook secret mismatch — rejected');
      res.sendStatus(401);
      return;
    }
    // Acknowledge immediately; process out of band so a slow swarm turn can't trigger a retry.
    res.sendStatus(200);
    const msg = parseTelegramUpdate(req.body);
    if (!msg) return;
    void handleInbound(ctx, links, msg).catch((err) => logger.error({ err }, 'telegram inbound handling failed'));
  });

  // ── AUTH-GATED: the cockpit "Channels" card ───────────────────────────────
  router.get('/', requiresAuth, (req, res) => void listChannels(links, req, res));
  router.post('/telegram/link', requiresAuth, (req, res) => void mintTelegramLink(links, req, res));
  router.delete('/telegram/:channelUserId', requiresAuth, (req, res) => void unlinkChannel(links, req, res));
  router.post('/telegram/register-webhook', requiresAuth, (req, res) => void doRegisterWebhook(req, res));

  return router;
}

/** GET / — the caller's linked channels + Telegram setup status (bot identity, token presence). */
async function listChannels(links: ChannelLinkService, req: Request, res: Response): Promise<void> {
  const sub = callerSub(req);
  if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
  const identity = await getTelegramBotIdentity();
  res.json({
    telegram: { configured: Boolean(getTelegramBotToken()), bot: identity },
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
