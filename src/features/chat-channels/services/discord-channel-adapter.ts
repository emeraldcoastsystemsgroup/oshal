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
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The Gateway now reports its state instead of failing silently: READY records the bot user and marks the connection live; a close with code 4004 (bad token) or 4013/4014 (intents refused - the Message Content intent is off in the Developer Portal) is recorded as a named problem and NOT retried, because Discord will refuse the same IDENTIFY forever and the operator needs the reason on the cockpit card, not a reconnect loop in a container log. Every handle exposes status(); startDiscordGateway takes an onStatus hook and a gatewayUrl seam. The long connect closure is split into a session object with small handlers.
 */

import WebSocket from 'ws';
import { createChildLogger } from '@/shared/logger';

export const DISCORD_CHANNEL_PROVIDER = 'discord';
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
/** The Discord REST base; a spec points the identity validation at a local fake instead. */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';
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

/** Where the Gateway connection stands, as the cockpit card shows it. */
export interface DiscordGatewayStatus {
  /** connecting: socket opened, no READY yet; connected: READY received; offline: closed (reconnect pending or refused); stopped: stop() was called or nothing was started. */
  state: 'connecting' | 'connected' | 'offline' | 'stopped';
  /** The last Gateway close code, when the socket has closed at least once. */
  lastCloseCode: number | null;
  /** A close Discord will repeat for the same token: the token is bad, or a privileged intent is off. Null while none. */
  problem: 'token_invalid' | 'intent_missing' | null;
  /** When READY last arrived. */
  connectedAt: string | null;
  /** The bot user READY named. */
  botUserId: string | null;
  botUsername: string | null;
}

export interface DiscordGatewayOptions {
  token?: string | null;
  socketFactory?: (url: string) => DiscordSocket;
  reconnectDelayMs?: number;
  /** Called only when a Gateway message omits its optional channel_type field. */
  channelTypeResolver?: (channelId: string, token: string) => Promise<number | null>;
  /** The Gateway URL to dial; a spec points it at a local WebSocket server. */
  gatewayUrl?: string;
  /** Observes every status change (READY, close, refusal). */
  onStatus?: (status: DiscordGatewayStatus) => void;
}

export interface DiscordGatewayHandle {
  stop(): void;
  /** A snapshot of where the connection stands right now. */
  status(): DiscordGatewayStatus;
}

/** Close codes Discord answers the same IDENTIFY with every time; reconnecting cannot fix them. */
const FATAL_CLOSE_PROBLEMS: Record<number, DiscordGatewayStatus['problem']> = {
  4004: 'token_invalid',
  4013: 'intent_missing',
  4014: 'intent_missing',
};

async function getDiscordChannelType(channelId: string, token: string): Promise<number | null> {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { id?: unknown; type?: unknown };
  return body.id === channelId && Number.isInteger(body.type) ? Number(body.type) : null;
}

/** A Gateway packet as the session reads it. */
interface GatewayPacket { op?: number; t?: string; s?: number | null; d?: unknown }

/** Everything one Gateway listener holds across reconnects; the handlers below are small functions over it. */
interface GatewaySession {
  token: string;
  gatewayUrl: string;
  socketFactory: (url: string) => DiscordSocket;
  reconnectDelayMs: number;
  resolveChannelType: (channelId: string, token: string) => Promise<number | null>;
  onMessage: (message: InboundDiscordMessage) => void | Promise<void>;
  onStatus?: (status: DiscordGatewayStatus) => void;
  status: DiscordGatewayStatus;
  knownChannelTypes: Map<string, number>;
  pendingChannelTypes: Map<string, Promise<number | null>>;
  socket: DiscordSocket | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  sequence: number | null;
}

function publishStatus(session: GatewaySession, patch: Partial<DiscordGatewayStatus>): void {
  session.status = { ...session.status, ...patch };
  try { session.onStatus?.({ ...session.status }); } catch (err) { logger.warn({ err }, 'Discord Gateway status observer failed'); }
}

function deliver(session: GatewaySession, packet: unknown, verifiedChannelType?: number): void {
  if (session.stopped) return;
  const message = parseDiscordGatewayMessage(packet, verifiedChannelType);
  if (message) void Promise.resolve().then(() => session.onMessage(message)).catch((err) => logger.warn({ err }, 'Discord DM handler failed'));
}

/** The channel type for a channel, looked up once and cached (bounded). */
function verifiedType(session: GatewaySession, channelId: string): Promise<number | null> {
  const known = session.knownChannelTypes.get(channelId);
  if (known !== undefined) return Promise.resolve(known);
  const pending = session.pendingChannelTypes.get(channelId);
  if (pending) return pending;
  const lookup = session.resolveChannelType(channelId, session.token)
    .then((type) => {
      if (type !== null && Number.isInteger(type)) {
        if (session.knownChannelTypes.size >= 1024) session.knownChannelTypes.delete(session.knownChannelTypes.keys().next().value as string);
        session.knownChannelTypes.set(channelId, type);
      }
      return type;
    })
    .finally(() => { session.pendingChannelTypes.delete(channelId); });
  session.pendingChannelTypes.set(channelId, lookup);
  return lookup;
}

function clearTimers(session: GatewaySession): void {
  if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
  if (session.reconnect) { clearTimeout(session.reconnect); session.reconnect = null; }
}

/** HELLO: identify with the DM intents and start the heartbeat Discord asked for. */
function onHello(session: GatewaySession, packet: GatewayPacket): void {
  const interval = Number((packet.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
  session.socket?.send(JSON.stringify({ op: 2, d: { token: session.token, intents: DISCORD_INTENTS, properties: { os: 'oshal' } } }));
  if (Number.isFinite(interval) && interval > 0) {
    session.heartbeat = setInterval(() => session.socket?.send(JSON.stringify({ op: 1, d: session.sequence })), interval);
    session.heartbeat.unref();
  }
}

/** MESSAGE_CREATE: deliver a DM, verifying the channel type first when the event omits it. */
function onMessageCreate(session: GatewaySession, packet: GatewayPacket): void {
  const data = packet.d as Record<string, unknown> | null;
  if (data?.channel_type != null) { deliver(session, packet); return; }
  const channelId = typeof data?.channel_id === 'string' ? data.channel_id : '';
  if (data?.guild_id == null && /^\d{5,30}$/.test(channelId)) {
    void verifiedType(session, channelId)
      .then((type) => { if (type === 1) deliver(session, packet, type); })
      .catch((err) => logger.warn({ err, channelId }, 'Discord channel verification failed'));
  }
}

/** READY: the Gateway accepted the IDENTIFY; record the bot user it named. */
function onReady(session: GatewaySession, packet: GatewayPacket): void {
  const user = (packet.d as { user?: { id?: unknown; username?: unknown } } | null)?.user;
  const botUserId = typeof user?.id === 'string' ? user.id : null;
  const botUsername = typeof user?.username === 'string' ? user.username : null;
  logger.info({ botUserId }, 'Discord Gateway ready');
  publishStatus(session, { state: 'connected', problem: null, connectedAt: new Date().toISOString(), botUserId, botUsername });
}

function onPacket(session: GatewaySession, raw: unknown): void {
  let packet: GatewayPacket;
  try { packet = JSON.parse(String(raw)) as GatewayPacket; } catch { return; }
  if (typeof packet.s === 'number') session.sequence = packet.s;
  if (packet.op === 10) onHello(session, packet);
  else if (packet.op === 0 && packet.t === 'READY') onReady(session, packet);
  else if (packet.op === 0 && packet.t === 'MESSAGE_CREATE') onMessageCreate(session, packet);
  else if (packet.op === 7 || packet.op === 9) session.socket?.close();
}

/** A close: retry after the bounded delay, unless Discord named a reason a retry cannot change. */
function onClose(session: GatewaySession, code: unknown): void {
  clearTimers(session);
  const closeCode = typeof code === 'number' && Number.isInteger(code) ? code : null;
  const problem = closeCode !== null ? FATAL_CLOSE_PROBLEMS[closeCode] ?? null : null;
  if (session.stopped) return;
  if (problem) {
    logger.error({ closeCode, problem }, problem === 'intent_missing'
      ? 'Discord refused the Gateway intents: switch Message Content Intent ON under Bot -> Privileged Gateway Intents in the Developer Portal'
      : 'Discord rejected the bot token at the Gateway');
    publishStatus(session, { state: 'offline', lastCloseCode: closeCode, problem });
    return;
  }
  logger.warn({ closeCode }, 'Discord Gateway closed; reconnecting');
  publishStatus(session, { state: 'offline', lastCloseCode: closeCode });
  session.reconnect = setTimeout(() => connect(session), session.reconnectDelayMs);
  session.reconnect.unref();
}

function connect(session: GatewaySession): void {
  if (session.stopped) return;
  publishStatus(session, { state: 'connecting' });
  const socket = session.socketFactory(session.gatewayUrl);
  session.socket = socket;
  socket.on('open', () => { /* HELLO provides the heartbeat interval first. */ });
  socket.on('message', (raw: unknown) => onPacket(session, raw));
  socket.on('close', (code: unknown) => onClose(session, code));
  socket.on('error', () => { /* close schedules the bounded reconnect */ });
}

/** The status of a Gateway that was never started because no token is configured. */
function unconfiguredStatus(): DiscordGatewayStatus {
  return { state: 'stopped', lastCloseCode: null, problem: null, connectedAt: null, botUserId: null, botUsername: null };
}

/**
 * @description Starts the DM-only Gateway listener when a deployment token is configured.
 * @param onMessage - Receives each human DM the Gateway delivers.
 * @param options - Token, socket/URL seams, reconnect delay, channel-type resolver, status observer.
 * @returns A handle that stops the listener and reports its status.
 */
export function startDiscordGateway(
  onMessage: (message: InboundDiscordMessage) => void | Promise<void>,
  options: DiscordGatewayOptions = {},
): DiscordGatewayHandle {
  const token = options.token === undefined ? getDiscordBotToken() : options.token;
  if (!token) return { stop() { /* unconfigured is an explicit no-op */ }, status: unconfiguredStatus };
  const session: GatewaySession = {
    token,
    gatewayUrl: options.gatewayUrl ?? DISCORD_GATEWAY_URL,
    socketFactory: options.socketFactory ?? ((url) => new WebSocket(url) as unknown as DiscordSocket),
    reconnectDelayMs: Math.max(500, Math.min(options.reconnectDelayMs ?? 5_000, 60_000)),
    resolveChannelType: options.channelTypeResolver ?? getDiscordChannelType,
    onMessage,
    onStatus: options.onStatus,
    status: unconfiguredStatus(),
    knownChannelTypes: new Map(),
    pendingChannelTypes: new Map(),
    socket: null,
    heartbeat: null,
    reconnect: null,
    stopped: false,
    sequence: null,
  };
  connect(session);
  return {
    stop() {
      session.stopped = true;
      clearTimers(session);
      session.socket?.close();
      session.socket = null;
      publishStatus(session, { state: 'stopped' });
    },
    status: () => ({ ...session.status }),
  };
}
