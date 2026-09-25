/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-143 kernel stream guard: real local WebSocket protocol, default-off posture, refcounted subscriptions, reconnect/entitlement handling, symbol planning and credential-free snapshots.
 */

import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  marketStreamStatus,
  planSubscription,
  subscribeMarketPrints,
  type MarketPrint,
  type MarketStreamStatus,
} from '@/features/trading';
import { resetMarketStreamForTests } from '@/features/trading/services/market-data-stream';

const ENV_NAMES = [
  'TRADING_STREAM_ENABLED', 'ALPACA_STREAM_URL', 'TRADING_STREAM_MAX_SYMBOLS', 'TRADING_STREAM_STALE_SEC',
  'TRADING_STREAM_RECONNECT_MS', 'TRADING_STREAM_RECONNECT_MAX_MS', 'TRADING_STREAM_AUTH_COOLDOWN_MS',
  'TRADING_STREAM_IDLE_CLOSE_SEC', 'ALPACA_PAPER_KEY_ID', 'ALPACA_PAPER_SECRET_KEY', 'ALPACA_KEY_ID',
  'ALPACA_KEY', 'ALPAKA_KEY', 'ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET',
];

function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => predicate() ? resolve() : Date.now() - started > timeout ? reject(new Error('timed out')) : setTimeout(tick, 5);
    tick();
  });
}

describe('ADR-143 kernel market-data stream', () => {
  const original = new Map<string, string | undefined>();
  let server: WebSocketServer | undefined;

  beforeEach(() => {
    resetMarketStreamForTests();
    for (const name of ENV_NAMES) original.set(name, process.env[name]);
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.ALPACA_PAPER_KEY_ID = 'spec-key';
    process.env.ALPACA_PAPER_SECRET_KEY = 'spec-secret';
  });

  afterEach(async () => {
    resetMarketStreamForTests();
    for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    if (server) { server.close(); await once(server, 'close').catch(() => undefined); server = undefined; }
  });

  async function openVenue(onMessage?: (socket: WebSocket, message: any) => void): Promise<{ messages: any[]; socket: WebSocket }> {
    const messages: any[] = [];
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('venue did not bind');
    process.env.TRADING_STREAM_ENABLED = 'true';
    process.env.ALPACA_STREAM_URL = `ws://127.0.0.1:${address.port}/v2/iex`;
    let socket!: WebSocket;
    server.on('connection', (client) => {
      socket = client;
      client.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      client.on('message', (data) => {
        const message = JSON.parse(String(data)); messages.push(message); onMessage?.(client, message);
      });
    });
    return { messages, get socket() { return socket; } };
  }

  it('is default-off and makes no venue connection', async () => {
    process.env.ALPACA_STREAM_URL = 'ws://127.0.0.1:1/v2/iex';
    const received: MarketPrint[] = [];
    const stop = subscribeMarketPrints(['AAPL'], (print) => received.push(print));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(received).toEqual([]);
    expect(marketStreamStatus()).toMatchObject({ enabled: false, state: 'disabled', symbols: ['AAPL'] });
    stop();
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
    expect(JSON.stringify(received[0])).not.toContain('spec-secret');
    expect(JSON.stringify(marketStreamStatus())).not.toContain('spec-secret');
    expect(venue.messages.find((message) => message.action === 'auth')).toEqual({ action: 'auth', key: 'spec-key', secret: 'spec-secret' });
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
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connections).toBe(1);
    stop();
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
    expect(JSON.stringify(statuses)).not.toContain('spec-secret');
    stop();
  });
});
