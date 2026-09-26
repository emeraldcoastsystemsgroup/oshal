/**
 * Discord direct-message channel adapter.
 *
 * Discord delivers bot messages through its Gateway rather than an HTTP webhook.
 * This adapter deliberately accepts only MESSAGE_CREATE events from direct
 * channels, refuses guild/group traffic, and exposes an injected listener seam
 * so the app layer can resolve the linked owner before dispatch.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Added DM-only Gateway normalization, bounded reconnect handling, and owner-safe Discord reply primitive.
 */

import WebSocket from 'ws';
import { createChildLogger } from '@/shared/logger';

export const DISCORD_CHANNEL_PROVIDER = 'discord';
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_INTENTS = 4096 | 32768; // DIRECT_MESSAGES + MESSAGE_CONTENT
const DISCORD_REPLY_MAX_CHARS = 2_000;
const logger = createChildLogger({ module: 'discord-channel-adapter' });

export interface InboundDiscordMessage {
  provider: typeof DISCORD_CHANNEL_PROVIDER;
  eventId: string;
  channelUserId: string;
  channelId: string;
  text: string;
  displayName: string | null;
}

/** Parse only direct-message Gateway events; guild/group messages are refused. */
export function parseDiscordGatewayMessage(body: unknown, verifiedChannelType?: number): InboundDiscordMessage | null {
  const envelope = body as { op?: unknown; t?: unknown; d?: Record<string, unknown> } | null;
  if (envelope?.op !== 0 || envelope.t !== 'MESSAGE_CREATE') return null;
  const data = envelope.d;
  const author = data?.author as { id?: unknown; bot?: unknown; username?: unknown; global_name?: unknown } | undefined;
  const channelType = Number(data?.channel_type ?? verifiedChannelType);
  const channelId = typeof data?.channel_id === 'string' ? data.channel_id.trim() : '';
  const eventId = typeof data?.id === 'string' ? data.id.trim() : '';
  const userId = typeof author?.id === 'string' ? author.id.trim() : '';
  const text = typeof data?.content === 'string' ? data.content.trim() : '';
  if (!/^\d{5,30}$/.test(eventId) || !channelId || !userId || !text || channelType !== 1 || author?.bot === true) return null;
  if (data?.guild_id != null) return null;
  return {
    provider: DISCORD_CHANNEL_PROVIDER,
    eventId,
    channelUserId: userId,
    channelId,
    text,
    displayName: typeof author?.global_name === 'string'
      ? author.global_name.trim() || null
      : typeof author?.username === 'string' ? author.username.trim() || null : null,
  };
}

export function getDiscordBotToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = (env.DISCORD_BOT_TOKEN || '').trim();
  return token || null;
}

/** Send a bounded reply to the exact Discord DM channel selected by the event. */
export async function sendDiscordMessage(channelId: string, text: string, token = getDiscordBotToken()): Promise<void> {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not configured');
  const channel = channelId.trim();
  if (!/^\d{5,30}$/.test(channel)) throw new Error('Discord channel id is invalid');
  const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channel)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: (text || '(no reply)').slice(0, DISCORD_REPLY_MAX_CHARS) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord send message failed: ${response.status}`);
}

interface DiscordSocket {
  on(event: string, listener: (...args: unknown[]) => void): DiscordSocket;
  send(payload: string): void;
  close(): void;
}

export interface DiscordGatewayOptions {
  token?: string | null;
  socketFactory?: (url: string) => DiscordSocket;
  reconnectDelayMs?: number;
  /** Called only when a Gateway message omits its optional channel_type field. */
  channelTypeResolver?: (channelId: string, token: string) => Promise<number | null>;
}

export interface DiscordGatewayHandle { stop(): void }

async function getDiscordChannelType(channelId: string, token: string): Promise<number | null> {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { id?: unknown; type?: unknown };
  return body.id === channelId && Number.isInteger(body.type) ? Number(body.type) : null;
}

/** Start the DM-only Gateway listener when a deployment token is configured. */
export function startDiscordGateway(
  onMessage: (message: InboundDiscordMessage) => void | Promise<void>,
  options: DiscordGatewayOptions = {},
): DiscordGatewayHandle {
  const token = options.token === undefined ? getDiscordBotToken() : options.token;
  if (!token) return { stop() { /* unconfigured is an explicit no-op */ } };
  const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as DiscordSocket);
  const reconnectDelayMs = Math.max(500, Math.min(options.reconnectDelayMs ?? 5_000, 60_000));
  const resolveChannelType = options.channelTypeResolver ?? getDiscordChannelType;
  const knownChannelTypes = new Map<string, number>();
  const pendingChannelTypes = new Map<string, Promise<number | null>>();
  let socket: DiscordSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let sequence: number | null = null;

  const deliver = (packet: unknown, verifiedChannelType?: number) => {
    if (stopped) return;
    const message = parseDiscordGatewayMessage(packet, verifiedChannelType);
    if (message) void Promise.resolve().then(() => onMessage(message)).catch((err) => logger.warn({ err }, 'Discord DM handler failed'));
  };

  const verifiedType = (channelId: string): Promise<number | null> => {
    const known = knownChannelTypes.get(channelId);
    if (known !== undefined) return Promise.resolve(known);
    const pending = pendingChannelTypes.get(channelId);
    if (pending) return pending;
    const lookup = resolveChannelType(channelId, token)
      .then((type) => {
        if (type !== null && Number.isInteger(type)) {
          if (knownChannelTypes.size >= 1024) knownChannelTypes.delete(knownChannelTypes.keys().next().value as string);
          knownChannelTypes.set(channelId, type);
        }
        return type;
      })
      .finally(() => { pendingChannelTypes.delete(channelId); });
    pendingChannelTypes.set(channelId, lookup);
    return lookup;
  };

  const clearTimers = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (reconnect) { clearTimeout(reconnect); reconnect = null; }
  };
  const connect = () => {
    if (stopped) return;
    socket = socketFactory(DISCORD_GATEWAY_URL);
    socket.on('open', () => { /* HELLO provides the heartbeat interval first. */ });
    socket.on('message', (raw: unknown) => {
      let packet: { op?: number; t?: string; s?: number | null; d?: unknown };
      try { packet = JSON.parse(String(raw)) as typeof packet; } catch { return; }
      if (typeof packet.s === 'number') sequence = packet.s;
      if (packet.op === 10) {
        const interval = Number((packet.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
        socket?.send(JSON.stringify({ op: 2, d: { token, intents: DISCORD_INTENTS, properties: { os: 'oshal' } } }));
        if (Number.isFinite(interval) && interval > 0) {
          heartbeat = setInterval(() => socket?.send(JSON.stringify({ op: 1, d: sequence })), interval);
          heartbeat.unref();
        }
      } else if (packet.op === 0 && packet.t === 'MESSAGE_CREATE') {
        const data = packet.d as Record<string, unknown> | null;
        if (data?.channel_type != null) {
          deliver(packet);
        } else {
          const channelId = typeof data?.channel_id === 'string' ? data.channel_id : '';
          if (data?.guild_id == null && /^\d{5,30}$/.test(channelId)) {
            void verifiedType(channelId)
              .then((type) => { if (type === 1) deliver(packet, type); })
              .catch((err) => logger.warn({ err, channelId }, 'Discord channel verification failed'));
          }
        }
      } else if (packet.op === 7 || packet.op === 9) {
        socket?.close();
      }
    });
    socket.on('close', () => {
      clearTimers();
      if (!stopped) { reconnect = setTimeout(connect, reconnectDelayMs); reconnect.unref(); }
    });
    socket.on('error', () => { /* close schedules the bounded reconnect */ });
  };
  connect();
  return {
    stop() {
      stopped = true;
      clearTimers();
      socket?.close();
      socket = null;
    },
  };
}
