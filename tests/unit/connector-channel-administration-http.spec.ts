/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Actual HTTP gates refuse global connector/channel mutations before effects and preserve caller overrides and linking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorChannelAdministrationFixture } from '../fixtures/connector-channel-administration';
import { deriveWebhookSecret } from '@/features/chat-channels';

const provider = vi.hoisted(() => ({ webhook: vi.fn(async (base: string) => `${base}/api/channels/telegram/webhook`) }));
const FIXTURE_CREDENTIAL = 'fixture-value-with-no-provider-authority';
vi.mock('@/features/chat-channels', async original => ({ ...await original<typeof import('@/features/chat-channels')>(),
  registerTelegramWebhook: provider.webhook, getTelegramBotIdentity: vi.fn(async () => ({ username: 'FixtureBot', id: 123 })),
  getTelegramBotToken: () => FIXTURE_CREDENTIAL,
}));

let fixture: Awaited<ReturnType<typeof connectorChannelAdministrationFixture>>;
beforeEach(async () => { provider.webhook.mockClear(); fixture = await connectorChannelAdministrationFixture(); });
afterEach(async () => { await fixture?.close(); });
const GLOBAL = [
  ['POST', '/api/connectors/marketplace/fixture-provider/enable'],
  ['POST', '/api/connectors/marketplace/fixture-provider/disable'],
  ['POST', '/api/connectors/marketplace/fixture-provider/remove'],
  ['DELETE', '/api/connectors/marketplace/fixture-provider'],
  ['POST', '/api/connectors/marketplace/fixture-provider/audit-refresh'],
  ['POST', '/api/channels/telegram/register-webhook'],
];

describe('operator-only global connector and channel administration', () => {
  it.each(GLOBAL)('refuses anonymous and ordinary %s %s before global effects', async (method, route) => {
    expect((await fixture.call(route, method, 'anonymous')).status).toBe(401);
    const response = await fixture.call(route + '?operator=true&sub=fixture-operator', method, 'member',
      { baseUrl: 'https://fixture.invalid', operator: true, sub: 'fixture-operator' });
    expect(response.status).toBe(403);
    for (const effect of [fixture.mutate, fixture.register, fixture.deregister, provider.webhook]) expect(effect).not.toHaveBeenCalled();
  });

  it.each(GLOBAL)('allows an operator to perform %s %s against isolated effects', async (method, route) => {
    const response = await fixture.call(route, method, 'operator', { baseUrl: 'https://fixture.invalid' });
    expect(response.status).toBe(200);
    if (route.includes('register-webhook')) expect(provider.webhook).toHaveBeenCalledExactlyOnceWith('https://fixture.invalid');
    else expect(fixture.mutate).toHaveBeenCalledExactlyOnceWith('fixture-provider');
  });

  it('keeps per-user overrides bound to the member rather than supplied operator identity', async () => {
    expect((await fixture.call('/api/connectors/marketplace/fixture-provider/disable-for-me', 'POST', 'member',
      { sub: 'fixture-operator' })).status).toBe(200);
    expect(fixture.setForUser).toHaveBeenCalledExactlyOnceWith('fixture-member', 'fixture-provider', false);
    const own = await fixture.call('/api/connectors/marketplace/my-enablement', 'GET');
    expect(await own.json()).toMatchObject({ data: { disabledProviders: ['fixture-provider'] } });
    const other = await fixture.call('/api/connectors/marketplace/my-enablement', 'GET', 'operator');
    expect(await other.json()).toMatchObject({ data: { disabledProviders: [] } });
    expect((await fixture.call('/api/connectors/marketplace/fixture-provider/enable-for-me')).status).toBe(200);
    expect(fixture.mutate).not.toHaveBeenCalled(); expect(fixture.register).not.toHaveBeenCalled();
  });

  it('keeps Telegram member linking and unlinking on the verified caller', async () => {
    expect((await fixture.call('/api/channels/telegram/link')).status).toBe(200);
    expect(fixture.mint).toHaveBeenCalledWith('fixture-member', 'telegram', 'https://identity.example.test');
    expect((await fixture.call('/api/channels/telegram/123456', 'DELETE')).status).toBe(200);
    expect(fixture.unlink).toHaveBeenCalledWith('fixture-member', 'telegram', '123456');
    expect(provider.webhook).not.toHaveBeenCalled();
  });

  it('keeps the public inbound webhook independently secret-verified', async () => {
    const response = await fixture.call('/api/channels/telegram/webhook', 'POST', 'anonymous', { update_id: 1 });
    expect(response.status).toBe(401);
    const signature = deriveWebhookSecret(FIXTURE_CREDENTIAL);
    const accepted = await fixture.call('/api/channels/telegram/webhook', 'POST', 'anonymous', { update_id: 2 },
      { 'x-telegram-bot-api-secret-token': signature });
    expect(accepted.status).toBe(200);
    expect(provider.webhook).not.toHaveBeenCalled(); expect(fixture.mint).not.toHaveBeenCalled();
  });

  it('honors removal of operator authority on the next request', async () => {
    vi.stubEnv('OSHAL_OPERATOR_SUBS', '');
    expect((await fixture.call(GLOBAL[0][1], 'POST', 'operator')).status).toBe(403);
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
});
