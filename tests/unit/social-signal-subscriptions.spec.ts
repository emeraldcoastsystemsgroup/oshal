import { describe, expect, it } from 'vitest';
import {
  matchesSocialSignalSelector,
  parseSocialSignalBotAgentId,
  parseSocialSignalSelector,
  pollSocialSignalSubscriptions,
  socialSignalChannel,
} from '../../src/app/routes/social-signal-subscriptions';
import type { MeshCommunicationService } from '../../src/features/agent-management';

describe('subscription-driven social signals', () => {
  it('bounds selector descriptors and matches account, keyword, and topic watches', () => {
    expect(parseSocialSignalSelector({ kind: 'keyword', value: ' futures ' })).toEqual({ kind: 'keyword', value: 'futures' });
    expect(parseSocialSignalSelector({ kind: 'unknown', value: 'futures' })).toBeNull();
    expect(parseSocialSignalSelector({ kind: 'keyword', value: 'x'.repeat(161) })).toBeNull();
    expect(parseSocialSignalBotAgentId('bot:research-1')).toBe('bot:research-1');
    expect(parseSocialSignalBotAgentId('bot with spaces')).toBeNull();

    const signal = { fromAddr: 'alerts@example.com', subject: 'Futures research note', snippet: 'Curve and basis update' };
    expect(matchesSocialSignalSelector({ kind: 'account', value: 'example.com' }, signal)).toBe(true);
    expect(matchesSocialSignalSelector({ kind: 'keyword', value: 'basis' }, signal)).toBe(true);
    expect(matchesSocialSignalSelector({ kind: 'topic', value: 'futures curve' }, signal)).toBe(true);
  });

  it('publishes matching rows to distinct derived owner/bot lanes and never leaks a raw subject key', async () => {
    const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const mesh = {
      send: async (envelope: { channel: string; payload: Record<string, unknown> }) => { published.push(envelope); },
    } as unknown as MeshCommunicationService;
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM oshal_social_signal_subscriptions s')) {
          return { rows: [
            { subscription_id: '11111111-1111-1111-1111-111111111111', user_sub: 'alice', bot_agent_id: 'research-a', selector: { kind: 'keyword', value: 'futures' }, msg_id: 'a-1', from_addr: 'news@example.com', subject: 'Futures update', snippet: 'basis', received_at: '2026-09-25T10:00:00.000Z', source: 'gmail' },
            { subscription_id: '22222222-2222-2222-2222-222222222222', user_sub: 'bob', bot_agent_id: 'research-b', selector: { kind: 'keyword', value: 'futures' }, msg_id: 'b-1', from_addr: 'news@example.com', subject: 'Futures update', snippet: 'basis', received_at: '2026-09-25T10:01:00.000Z', source: 'gmail' },
          ] };
        }
        if (sql.includes('INSERT INTO oshal_social_signal_deliveries')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
    } as never;

    const result = await pollSocialSignalSubscriptions(pool, mesh);
    expect(result).toEqual({ matched: 2, published: 2, failed: 0 });
    expect(published).toHaveLength(2);
    expect(published[0].channel).toBe(socialSignalChannel('alice', 'research-a'));
    expect(published[1].channel).toBe(socialSignalChannel('bob', 'research-b'));
    expect(published[0].channel).not.toContain('alice');
    expect(published[0].payload.ownerSub).toBe('alice');
    expect(published[1].payload.ownerSub).toBe('bob');
    expect(queries.filter((sql) => sql.includes('UPDATE oshal_social_signal_deliveries')).length).toBe(2);
  });

  it('removes a delivery claim when mesh publication fails so the next poll can retry', async () => {
    const mesh = { send: async () => { throw new Error('mesh unavailable'); } } as unknown as MeshCommunicationService;
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM oshal_social_signal_subscriptions s')) {
          return { rows: [{ subscription_id: '33333333-3333-3333-3333-333333333333', user_sub: 'alice', bot_agent_id: 'research-a', selector: { kind: 'keyword', value: 'futures' }, msg_id: 'a-1', from_addr: 'news@example.com', subject: 'Futures update', snippet: '', received_at: '2026-09-25T10:00:00.000Z', source: 'gmail' }] };
        }
        if (sql.includes('INSERT INTO oshal_social_signal_deliveries')) return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
    } as never;

    await expect(pollSocialSignalSubscriptions(pool, mesh)).resolves.toEqual({ matched: 1, published: 0, failed: 1 });
    expect(queries.some((sql) => sql.includes('DELETE FROM oshal_social_signal_deliveries'))).toBe(true);
  });
});
