/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-143 kernel stream guard: real local WebSocket protocol, default-off posture, refcounted subscriptions, reconnect/entitlement handling, symbol planning and credential-free snapshots.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Complete the ADR-143 "Guard specs" list: (5) a venue 405 trims to the cap with no subscribe loop, (7) the default-off case now runs against a LIVE fake venue that must record zero connections (the old case pointed at a closed port, which proves nothing about the module's restraint), (8) the module's pino child logger is captured through a real pino sink and every line written across the auth, entitlement, socket-error and close paths is checked for the key and secret. Plus the three source pins the ADR names: the barrel never re-exports alpacaDataCredentials, the stream module reads its env inside functions, and the order-pricing paths never subscribe to the display stream.
 */

import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tradingBarrel from '@/features/trading';
import {
  marketStreamStatus,
  planSubscription,
  subscribeMarketPrints,
  type MarketPrint,
  type MarketStreamStatus,
} from '@/features/trading';
import { resetMarketStreamForTests } from '@/features/trading/services/market-data-stream';

/**
 * Case (8): the module's child logger is a REAL pino logger whose destination is this sink, so the
 * captured lines are what pino would have written to stdout — serialization included — and the
 * assertion below reads them for the spec-set key and secret. Only createChildLogger is replaced;
 * every other logger export stays the original.
 */
const captured = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@/shared/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/shared/logger')>();
  const pino = (await import('pino')).default;
  const sink = pino({ level: 'trace' }, { write: (line: string) => { captured.lines.push(String(line)); } });
  return { ...original, createChildLogger: (bindings: Record<string, unknown>) => sink.child(bindings) };
});

const ENV_NAMES = [
  'TRADING_STREAM_ENABLED', 'ALPACA_STREAM_URL', 'TRADING_STREAM_MAX_SYMBOLS', 'TRADING_STREAM_STALE_SEC',
  'TRADING_STREAM_RECONNECT_MS', 'TRADING_STREAM_RECONNECT_MAX_MS', 'TRADING_STREAM_AUTH_COOLDOWN_MS',
  'TRADING_STREAM_IDLE_CLOSE_SEC', 'ALPACA_PAPER_KEY_ID', 'ALPACA_PAPER_SECRET_KEY', 'ALPACA_KEY_ID',
  'ALPACA_KEY', 'ALPAKA_KEY', 'ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET',
];
const KEY = 'spec-key';
const SECRET = 'spec-secret';

function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => predicate() ? resolve() : Date.now() - started > timeout ? reject(new Error('timed out')) : setTimeout(tick, 5);
    tick();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ADR-143 kernel market-data stream', () => {
  const original = new Map<string, string | undefined>();
  let server: WebSocketServer | undefined;

  beforeEach(() => {
    resetMarketStreamForTests();
    captured.lines.length = 0;
    for (const name of ENV_NAMES) original.set(name, process.env[name]);
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.ALPACA_PAPER_KEY_ID = KEY;
    process.env.ALPACA_PAPER_SECRET_KEY = SECRET;
  });

  afterEach(async () => {
    resetMarketStreamForTests();
    for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await closeVenue();
  });

  async function closeVenue(): Promise<void> {
    if (!server) return;
    for (const client of server.clients) client.terminate();
    server.close(); await once(server, 'close').catch(() => undefined); server = undefined;
  }

  /**
   * A real local venue speaking the Alpaca frame shape. `armed: false` leaves TRADING_STREAM_ENABLED
   * unset so the default-off case runs against a server that would accept a connection if one came.
   */
  async function openVenue(onMessage?: (socket: WebSocket, message: any) => void, options: { armed?: boolean } = {}) {
    const messages: any[] = [];
    const counters = { connections: 0 };
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('venue did not bind');
    if (options.armed !== false) process.env.TRADING_STREAM_ENABLED = 'true';
    process.env.ALPACA_STREAM_URL = `ws://127.0.0.1:${address.port}/v2/iex`;
    let socket!: WebSocket;
    server.on('connection', (client) => {
      counters.connections += 1;
      socket = client;
      client.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      client.on('message', (data) => {
        const message = JSON.parse(String(data)); messages.push(message); onMessage?.(client, message);
      });
    });
    return { messages, get socket() { return socket; }, get connections() { return counters.connections; } };
  }

  it('is default-off: a live fake venue records zero connections while unarmed', async () => {
    const venue = await openVenue(undefined, { armed: false });
    const received: MarketPrint[] = [];
    const stop = subscribeMarketPrints(['AAPL'], (print) => received.push(print));
    await sleep(60);
    expect(venue.connections).toBe(0);
    expect(marketStreamStatus()).toMatchObject({ enabled: false, state: 'disabled', symbols: ['AAPL'] });
    process.env.TRADING_STREAM_ENABLED = 'false';
    const second = subscribeMarketPrints(['MSFT'], (print) => received.push(print));
    await sleep(40);
    expect(venue.connections).toBe(0);
    expect(venue.messages).toEqual([]);
    expect(received).toEqual([]);
    expect(marketStreamStatus()).toMatchObject({ enabled: false, state: 'disabled', symbols: ['AAPL', 'MSFT'] });
    stop(); second();
  });

  it('authenticates locally and normalizes only valid trade frames', async () => {
    const venue = await openVenue((socket, message) => {
      if (message.action === 'auth') socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
      if (message.action === 'subscribe') socket.send(JSON.stringify([{ T: 't', S: 'AAPL', p: 189.5, s: 100, t: '2026-09-25T14:30:00.000Z', secret: 'drop-me' }]));
    });
    const received: MarketPrint[] = [];
    const stop = subscribeMarketPrints(['aapl'], (print) => received.push(print));
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ symbol: 'AAPL', price: 189.5, size: 100, asOf: new Date('2026-09-25T14:30:00.000Z'), feed: 'iex' });
    expect(JSON.stringify(received[0])).not.toContain(SECRET);
    expect(JSON.stringify(marketStreamStatus())).not.toContain(SECRET);
    expect(venue.messages.find((message) => message.action === 'auth')).toEqual({ action: 'auth', key: KEY, secret: SECRET });
    stop();
  });

  it('refcounts duplicate symbol listeners and unsubscribes after the last one leaves', async () => {
    const venue = await openVenue((socket, message) => { if (message.action === 'auth') socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }])); });
    const first = subscribeMarketPrints(['AAPL'], () => {});
    const second = subscribeMarketPrints(['AAPL'], () => {});
    await waitFor(() => venue.messages.some((message) => message.action === 'subscribe'));
    expect(venue.messages.filter((message) => message.action === 'subscribe')).toHaveLength(1);
    first(); second();
    await waitFor(() => venue.messages.some((message) => message.action === 'unsubscribe'));
    expect(venue.messages.filter((message) => message.action === 'unsubscribe')).toHaveLength(1);
  });

  it('reconnects after a drop and resends the current union', async () => {
    process.env.TRADING_STREAM_RECONNECT_MS = '10';
    process.env.TRADING_STREAM_RECONNECT_MAX_MS = '50';
    let connections = 0;
    const venue = await openVenue((socket, message) => {
      if (message.action === 'auth') {
        socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
        if (++connections === 1) setTimeout(() => socket.close(), 10);
      }
    });
    const stop = subscribeMarketPrints(['AAPL', 'MSFT'], () => {});
    await waitFor(() => venue.messages.filter((message) => message.action === 'subscribe').length >= 2);
    expect(venue.messages.filter((message) => message.action === 'subscribe').at(-1)?.trades).toEqual(['AAPL', 'MSFT']);
    stop();
  });

  it('blocks reconnects during an entitlement cooldown', async () => {
    process.env.TRADING_STREAM_AUTH_COOLDOWN_MS = '500';
    let connections = 0;
    await openVenue((socket, message) => {
      if (message.action === 'auth') { connections += 1; socket.send(JSON.stringify([{ T: 'error', code: 402, msg: 'subscription denied' }])); socket.close(); }
    });
    const stop = subscribeMarketPrints(['AAPL'], () => {});
    await waitFor(() => marketStreamStatus().state === 'entitlement_blocked');
    await sleep(80);
    expect(connections).toBe(1);
    stop();
  });

  it('trims to the cap after a venue 405 and never loops subscribe frames', async () => {
    process.env.TRADING_STREAM_MAX_SYMBOLS = '2';
    const venue = await openVenue((socket, message) => {
      if (message.action === 'auth') socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
      if (message.action === 'subscribe') socket.send(JSON.stringify([{ T: 'error', code: 405, msg: 'symbol limit exceeded' }]));
    });
    const stop = subscribeMarketPrints(['AAPL', 'MSFT', 'NVDA'], () => {});
    await waitFor(() => marketStreamStatus().lastError === 'symbol limit exceeded');
    const framesAtRefusal = venue.messages.length;
    const tail = subscribeMarketPrints(['NVDA'], () => {});
    await sleep(80);
    const subscribes = venue.messages.filter((message) => message.action === 'subscribe');
    expect(subscribes[0].trades).toEqual(['AAPL', 'MSFT']);
    expect(venue.messages.slice(framesAtRefusal).filter((message) => message.action === 'subscribe').length).toBeLessThanOrEqual(2);
    expect(venue.messages.filter((message) => message.action === 'unsubscribe')).toHaveLength(0);
    expect(marketStreamStatus()).toMatchObject({ state: 'authenticated', symbols: ['AAPL', 'MSFT'], dropped: ['NVDA'] });
    expect(venue.connections).toBe(1);
    tail(); stop();
  });

  it('plans ticket-first subscriptions and drops only the tail', () => {
    expect(planSubscription(['aapl', 'MSFT', 'aapl', 'nvda'], 2)).toEqual({ accepted: ['AAPL', 'MSFT'], dropped: ['NVDA'] });
  });

  it('publishes a credential-free status snapshot', () => {
    process.env.TRADING_STREAM_MAX_SYMBOLS = '2';
    process.env.TRADING_STREAM_STALE_SEC = '45';
    const statuses: MarketStreamStatus[] = [];
    const stop = subscribeMarketPrints(['AAPL', 'MSFT', 'NVDA'], () => {}, (status) => statuses.push(status));
    expect(marketStreamStatus()).toMatchObject({ enabled: false, maxSymbols: 2, staleAfterSec: 45, symbols: ['AAPL', 'MSFT'], dropped: ['NVDA'] });
    expect(JSON.stringify(statuses)).not.toContain(SECRET);
    stop();
  });

  it('never writes the key or secret to its logger across the auth, close, socket-error and entitlement paths', async () => {
    process.env.TRADING_STREAM_RECONNECT_MS = '10';
    process.env.TRADING_STREAM_RECONNECT_MAX_MS = '20';
    process.env.TRADING_STREAM_AUTH_COOLDOWN_MS = '500';
    const venue = await openVenue((socket, message) => { if (message.action === 'auth') socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }])); });
    const prints: MarketPrint[] = [];
    const statuses: MarketStreamStatus[] = [];
    const stop = subscribeMarketPrints(['AAPL'], (print) => prints.push(print), (status) => statuses.push(status));
    await waitFor(() => marketStreamStatus().state === 'authenticated');
    expect(venue.messages.find((message) => message.action === 'auth')?.secret).toBe(SECRET);
    await closeVenue();                                   // the venue vanishes: close path, then a refused reconnect
    await waitFor(() => captured.lines.some((line) => line.includes('market-data stream socket error')));
    stop();
    resetMarketStreamForTests();
    await openVenue((socket, message) => {
      if (message.action === 'auth') { socket.send(JSON.stringify([{ T: 'error', code: 402, msg: 'subscription denied' }])); socket.close(); }
    });
    const blocked = subscribeMarketPrints(['AAPL'], () => {}, (status) => statuses.push(status));
    await waitFor(() => marketStreamStatus().state === 'entitlement_blocked');
    blocked();
    const text = captured.lines.join('');
    for (const expected of ['market-data stream authenticated', 'market-data stream closed', 'market-data stream socket error', 'market-data stream entitlement refused']) {
      expect(text, expected).toContain(expected);
    }
    for (const line of captured.lines) {
      expect(JSON.parse(line)).toMatchObject({ module: 'market-data-stream' });
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(SECRET);
    }
    expect(JSON.stringify({ prints, statuses, status: marketStreamStatus() })).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
  });
});

describe('ADR-143 source pins', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('the trading barrel never re-exports the venue credential reader', () => {
    expect(read('src/features/trading/index.ts')).not.toContain('alpacaDataCredentials');
    expect((tradingBarrel as Record<string, unknown>).alpacaDataCredentials).toBeUndefined();
  });

  it('the stream module reads its environment inside functions, never as a module constant', () => {
    const source = read('src/features/trading/services/market-data-stream.ts');
    expect(source).toContain("function enabled(): boolean { return process.env.TRADING_STREAM_ENABLED === 'true'; }");
    expect(source).not.toMatch(/^(?:export\s+)?(?:const|let|var)\b[^\n]*process\.env/m);
  });

  it('the order-pricing paths never subscribe to the display stream', () => {
    for (const path of ['src/app/trading-engine.ts', 'src/app/trading-schedule-dispatch.ts', 'src/app/trading-event-plans.ts']) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
      expect(read(path), path).not.toContain('subscribeMarketPrints');
    }
  });
});
