import { describe, expect, it } from 'vitest';
import {
  DISCORD_CHANNEL_PROVIDER,
  parseDiscordGatewayMessage,
  startDiscordGateway,
} from '@/features/chat-channels';
import { processDiscordInbound } from '@/app/routes/chat-channel-routes';

describe('Discord direct-message channel adapter', () => {
  it('accepts a human DM and refuses guild, group, bot, and non-message events', () => {
    const dm = parseDiscordGatewayMessage({
      op: 0, t: 'MESSAGE_CREATE', d: {
        id: '333333333', channel_id: '123456789', channel_type: 1, content: '  summarize my day  ',
        author: { id: '987654321', username: 'roger', global_name: 'Roger', bot: false },
      },
    });
    expect(dm).toEqual({ provider: DISCORD_CHANNEL_PROVIDER, eventId: '333333333', channelUserId: '987654321', channelId: '123456789', text: 'summarize my day', displayName: 'Roger' });
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 1, guild_id: 'guild', content: 'no', author: { id: '1' } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 3, content: 'group', author: { id: '1' } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 1, content: 'bot', author: { id: '1', bot: true } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 10, t: null, d: {} })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 1, content: 'no id', author: { id: '987654321' } } })).toBeNull();
  });

  it('identifies the gateway and routes a DM through the injected socket without opening a network socket', async () => {
    const sent: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      on(event: string, listener: (...args: unknown[]) => void) { handlers.set(event, listener); return socket; },
      send(payload: string) { sent.push(payload); },
      close() { handlers.get('close')?.(); },
    };
    const received: string[] = [];
    const fixtureToken = 'd'.repeat(16);
    const handle = startDiscordGateway((message) => { received.push(message.text); }, {
      token: fixtureToken,
      socketFactory: () => socket,
      reconnectDelayMs: 60_000,
    });
    handlers.get('message')?.(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    handlers.get('message')?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: '333333333', channel_id: '123456789', channel_type: 1, content: 'hello', author: { id: '987654321' } } }));
    await Promise.resolve();
    expect(JSON.parse(sent[0])).toMatchObject({ op: 2, d: { token: fixtureToken, intents: 36864 } });
    expect(received).toEqual(['hello']);
    handle.stop();
  });

  it('verifies omitted channel_type before delivering a DM and rejects a verified group channel', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      on(event: string, listener: (...args: unknown[]) => void) { handlers.set(event, listener); return socket; },
      send() {},
      close() { handlers.get('close')?.(); },
    };
    const received: string[] = [];
    const lookedUp: string[] = [];
    const handle = startDiscordGateway((message) => { received.push(message.text); }, {
      token: 'd'.repeat(16), socketFactory: () => socket,
      channelTypeResolver: async (channelId) => {
        lookedUp.push(channelId);
        return channelId === '123456789' ? 1 : 3;
      },
    });
    const sendEvent = (id: string, channelId: string, text: string) => handlers.get('message')?.(JSON.stringify({
      op: 0, t: 'MESSAGE_CREATE', d: { id, channel_id: channelId, content: text, author: { id: '987654321' } },
    }));
    sendEvent('333333333', '123456789', 'dm');
    sendEvent('333333334', '123456789', 'dm again');
    sendEvent('333333335', '223456789', 'group');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(['dm', 'dm again']);
    expect(lookedUp).toEqual(['123456789', '223456789']);
    handle.stop();
  });

  it('redeems LINK before owner lookup, dispatches once for a linked DM, and refuses unlinked identities', async () => {
    const calls: string[] = [];
    let owner: string | null = null;
    const seen = new Set<string>();
    const links = {
      async redeemLinkCode(provider: string, code: string, userId: string, channelId: string) {
        calls.push(`redeem:${provider}:${code}:${userId}:${channelId}`);
        if (code !== 'abcd1234') return null;
        owner = 'owner-1';
        return owner;
      },
      async resolveLink(provider: string, userId: string) {
        calls.push(`resolve:${provider}:${userId}`);
        return owner ? { userSub: owner } : null;
      },
      async claimInboundMessage(sub: string, provider: string, eventId: string) {
        calls.push(`claim:${sub}:${provider}:${eventId}`);
        if (seen.has(eventId)) return false;
        seen.add(eventId);
        return true;
      },
    };
    const send = async (_channelId: string, text: string) => { calls.push(`send:${text}`); };
    const dispatch = async (sub: string) => { calls.push(`dispatch:${sub}`); return 'done'; };
    const message = { provider: DISCORD_CHANNEL_PROVIDER, eventId: '333333333', channelUserId: '987654321', channelId: '123456789', text: 'task', displayName: 'Roger' } as const;
    await processDiscordInbound(links, message, dispatch, send);
    expect(calls).not.toContain('dispatch:owner-1');
    expect(calls.at(-1)).toContain('not linked');
    calls.length = 0;
    await processDiscordInbound(links, { ...message, text: 'LINK ABCD1234' }, dispatch, send);
    expect(calls).toEqual(['redeem:discord:abcd1234:987654321:123456789', 'send:Connected. You can now message your swarm from this DM.']);
    calls.length = 0;
    await processDiscordInbound(links, message, dispatch, send);
    await processDiscordInbound(links, message, dispatch, send);
    expect(calls.filter((entry) => entry === 'dispatch:owner-1')).toHaveLength(1);
    expect(calls.filter((entry) => entry === 'send:done')).toHaveLength(1);
  });
});
