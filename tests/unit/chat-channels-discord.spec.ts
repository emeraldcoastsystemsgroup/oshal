import { describe, expect, it } from 'vitest';
import {
  DISCORD_CHANNEL_PROVIDER,
  parseDiscordGatewayMessage,
  startDiscordGateway,
} from '@/features/chat-channels';

describe('Discord direct-message channel adapter', () => {
  it('accepts a human DM and refuses guild, group, bot, and non-message events', () => {
    const dm = parseDiscordGatewayMessage({
      op: 0, t: 'MESSAGE_CREATE', d: {
        channel_id: '123456789', channel_type: 1, content: '  summarize my day  ',
        author: { id: '987654321', username: 'roger', global_name: 'Roger', bot: false },
      },
    });
    expect(dm).toEqual({ provider: DISCORD_CHANNEL_PROVIDER, channelUserId: '987654321', channelId: '123456789', text: 'summarize my day', displayName: 'Roger' });
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 1, guild_id: 'guild', content: 'no', author: { id: '1' } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 3, content: 'group', author: { id: '1' } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: '123456789', channel_type: 1, content: 'bot', author: { id: '1', bot: true } } })).toBeNull();
    expect(parseDiscordGatewayMessage({ op: 10, t: null, d: {} })).toBeNull();
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
    handlers.get('message')?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { channel_id: '123456789', channel_type: 1, content: 'hello', author: { id: '987654321' } } }));
    await Promise.resolve();
    expect(JSON.parse(sent[0])).toMatchObject({ op: 2, d: { token: fixtureToken, intents: 36864 } });
    expect(received).toEqual(['hello']);
    handle.stop();
  });
});
