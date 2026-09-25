/**
 * Alpaca IEX market-data stream (ADR-143).
 *
 * The venue socket belongs to the kernel, not a store package or browser. One process-wide
 * connection is shared by refcounted symbol listeners because Alpaca limits connections per key.
 * The feature is default-off and display-only; order pricing continues to use REST latestTrade().
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-143 Phase 1: default-off refcounted Alpaca IEX stream with reconnect, entitlement handling, symbol planning and allowlisted print frames.
 */

import WebSocket from 'ws';
import { createChildLogger } from '@/shared/logger';
import { alpacaDataCredentials } from './market-data';

const logger = createChildLogger({ module: 'market-data-stream' });

export interface MarketPrint {
  symbol: string;
  price: number;
  size: number;
  asOf: Date;
  feed: string;
}

export type MarketStreamState = 'disabled' | 'idle' | 'connecting' | 'authenticated' | 'backoff' | 'entitlement_blocked';

export interface MarketStreamStatus {
  enabled: boolean;
  state: MarketStreamState;
  feed: string;
  maxSymbols: number;
  staleAfterSec: number;
  symbols: string[];
  dropped: string[];
  lastError: string | null;
  lastPrintAt: string | null;
}

type PrintListener = (print: MarketPrint) => void;
type StatusListener = (status: MarketStreamStatus) => void;

const DEFAULT_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const DEFAULT_MAX_SYMBOLS = 30;
const DEFAULT_STALE_SEC = 60;
const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_AUTH_COOLDOWN_MS = 300_000;
const DEFAULT_IDLE_CLOSE_MS = 120_000;

const listeners = new Map<string, Set<PrintListener>>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | null = null;
let state: MarketStreamState = 'idle';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let blockedTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = DEFAULT_RECONNECT_MS;
let subscribedSymbols: string[] = [];
let lastError: string | null = null;
let lastPrintAt: string | null = null;

function numberEnv(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function enabled(): boolean { return process.env.TRADING_STREAM_ENABLED === 'true'; }
function streamUrl(): string { return (process.env.ALPACA_STREAM_URL || DEFAULT_URL).trim() || DEFAULT_URL; }
function feedName(): string { return streamUrl().split('/').filter(Boolean).pop() || 'iex'; }
function maxSymbols(): number { return Math.floor(numberEnv('TRADING_STREAM_MAX_SYMBOLS', DEFAULT_MAX_SYMBOLS, 1)); }
function staleAfterSec(): number { return numberEnv('TRADING_STREAM_STALE_SEC', DEFAULT_STALE_SEC, 1); }
function authCooldownMs(): number { return numberEnv('TRADING_STREAM_AUTH_COOLDOWN_MS', DEFAULT_AUTH_COOLDOWN_MS, 1); }
function reconnectBaseMs(): number { return numberEnv('TRADING_STREAM_RECONNECT_MS', DEFAULT_RECONNECT_MS, 1); }
function reconnectMaxMs(): number { return Math.max(reconnectBaseMs(), numberEnv('TRADING_STREAM_RECONNECT_MAX_MS', DEFAULT_RECONNECT_MAX_MS, 1)); }
function idleCloseMs(): number { return numberEnv('TRADING_STREAM_IDLE_CLOSE_SEC', DEFAULT_IDLE_CLOSE_MS / 1000, 1) * 1000; }

/** Keep requested symbols stable and preserve the ticket-first insertion order. */
export function planSubscription(symbols: string[], cap = maxSymbols()): { accepted: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const ordered = symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter((symbol) => symbol && !seen.has(symbol) && seen.add(symbol));
  const limit = Math.max(1, Math.floor(cap));
  return { accepted: ordered.slice(0, limit), dropped: ordered.slice(limit) };
}

function currentPlan(): { accepted: string[]; dropped: string[] } {
  return planSubscription([...listeners.keys()]);
}

function status(): MarketStreamStatus {
  const plan = currentPlan();
  const currentState = enabled() ? (listeners.size ? state : 'idle') : 'disabled';
  return {
    enabled: enabled(), state: currentState, feed: feedName(), maxSymbols: maxSymbols(), staleAfterSec: staleAfterSec(),
    symbols: plan.accepted, dropped: plan.dropped, lastError, lastPrintAt,
  };
}

function publishStatus(): void {
  const snapshot = status();
  for (const listener of statusListeners) {
    try { listener(snapshot); } catch { /* a status observer must not break the venue rail */ }
  }
}

function safeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value || 'stream error');
  return text.replace(/(APCA-[A-Z0-9_-]+|[A-Za-z0-9_-]{16,})/g, '[redacted]').slice(0, 240);
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendSubscriptions(next: string[]): void {
  const wanted = new Set(next);
  const prior = new Set(subscribedSymbols);
  const add = next.filter((symbol) => !prior.has(symbol));
  const remove = subscribedSymbols.filter((symbol) => !wanted.has(symbol));
  if (add.length) send({ action: 'subscribe', trades: add });
  if (remove.length) send({ action: 'unsubscribe', trades: remove });
  subscribedSymbols = [...next];
}

function fanOut(raw: unknown): void {
  const frame = raw as { T?: unknown; S?: unknown; p?: unknown; s?: unknown; t?: unknown };
  if (frame.T !== 't' || typeof frame.S !== 'string') return;
  const price = Number(frame.p); const size = Number(frame.s); const asOf = new Date(String(frame.t));
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0 || Number.isNaN(asOf.getTime())) return;
  const print: MarketPrint = { symbol: frame.S.toUpperCase(), price, size, asOf, feed: feedName() };
  lastPrintAt = asOf.toISOString();
  for (const listener of listeners.get(print.symbol) || []) {
    try { listener(print); } catch { /* one surface cannot terminate the shared stream */ }
  }
  publishStatus();
}

function onFrame(text: string): void {
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return; }
  const frames = Array.isArray(decoded) ? decoded : [decoded];
  for (const frame of frames) {
    const row = frame as { T?: unknown; msg?: unknown; code?: unknown };
    if (row.T === 'success' && row.msg === 'connected') { const credentials = alpacaDataCredentials(); send({ action: 'auth', key: credentials.id, secret: credentials.secret }); continue; }
    if (row.T === 'success' && row.msg === 'authenticated') { state = 'authenticated'; reconnectDelay = reconnectBaseMs(); lastError = null; sendSubscriptions(currentPlan().accepted); logger.info({ feed: feedName() }, 'market-data stream authenticated'); publishStatus(); continue; }
    if (row.T === 'error') {
      const code = Number(row.code); lastError = safeError(row.msg);
      if ([402, 406, 409].includes(code)) { state = 'entitlement_blocked'; logger.error({ code, message: lastError }, 'market-data stream entitlement refused'); scheduleBlockedRetry(); }
      else if (code === 405) { subscribedSymbols = currentPlan().accepted; logger.error({ code, maxSymbols: maxSymbols() }, 'market-data stream symbol cap refused'); publishStatus(); }
      else { logger.error({ code, message: lastError }, 'market-data stream rejected'); }
      publishStatus(); continue;
    }
    if (row.T === 't') fanOut(frame);
  }
}

function scheduleBlockedRetry(): void {
  if (blockedTimer) return;
  blockedTimer = setTimeout(() => { blockedTimer = null; if (listeners.size && enabled()) connect(); }, authCooldownMs());
}

function scheduleReconnect(): void {
  if (reconnectTimer || blockedTimer || !listeners.size || !enabled()) return;
  state = 'backoff'; publishStatus();
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectMaxMs(), Math.max(reconnectBaseMs(), reconnectDelay * 2));
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function closeSocket(): void {
  const open = socket;
  socket = null;
  subscribedSymbols = [];
  if (open && open.readyState === WebSocket.OPEN) open.close();
}

function connect(): void {
  if (!enabled() || !listeners.size || socket || blockedTimer) return;
  const credentials = alpacaDataCredentials();
  if (!credentials.id || !credentials.secret) { state = 'idle'; lastError = 'market_data_credentials_missing'; publishStatus(); return; }
  state = 'connecting'; publishStatus();
  const next = new WebSocket(streamUrl());
  socket = next;
  next.on('message', (data) => onFrame(String(data)));
  next.on('error', (error) => { lastError = safeError(error); logger.error({ message: lastError }, 'market-data stream socket error'); publishStatus(); });
  next.on('close', () => { if (socket !== next) return; socket = null; subscribedSymbols = []; if (state !== 'entitlement_blocked') { state = listeners.size && enabled() ? 'backoff' : 'idle'; logger.info({ feed: feedName() }, 'market-data stream closed'); scheduleReconnect(); } publishStatus(); });
}

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; if (!listeners.size) { closeSocket(); state = 'idle'; publishStatus(); } }, idleCloseMs());
}

/** Subscribe one surface listener; the final unsubscribe releases the venue socket after a grace period. */
export function subscribeMarketPrints(symbols: string[], onPrint: PrintListener, onStatus?: StatusListener): () => void {
  const normalized = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
  if (onStatus) statusListeners.add(onStatus);
  for (const symbol of normalized) (listeners.get(symbol) || (listeners.set(symbol, new Set()), listeners.get(symbol)!)).add(onPrint);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (enabled()) { connect(); if (state === 'authenticated') sendSubscriptions(currentPlan().accepted); }
  publishStatus();
  return () => {
    for (const symbol of normalized) { const set = listeners.get(symbol); if (!set) continue; set.delete(onPrint); if (!set.size) listeners.delete(symbol); }
    if (onStatus) statusListeners.delete(onStatus);
    if (!listeners.size) { if (state === 'authenticated') sendSubscriptions([]); armIdleClose(); }
    else if (state === 'authenticated') sendSubscriptions(currentPlan().accepted);
    publishStatus();
  };
}

/** @returns A credential-free snapshot suitable for a route or test receipt. */
export function marketStreamStatus(): MarketStreamStatus { return status(); }

/** Reset only the process singleton; test-only and never called by production routes. */
export function resetMarketStreamForTests(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (blockedTimer) clearTimeout(blockedTimer);
  if (idleTimer) clearTimeout(idleTimer);
  reconnectTimer = blockedTimer = idleTimer = null;
  closeSocket();
  listeners.clear(); statusListeners.clear(); subscribedSymbols = []; reconnectDelay = DEFAULT_RECONNECT_MS;
  state = 'idle'; lastError = null; lastPrintAt = null;
}
