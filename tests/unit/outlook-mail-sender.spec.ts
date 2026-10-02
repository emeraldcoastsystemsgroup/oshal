/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Boundary guards for the fixed Outlook send seam: sender grant selection fails closed, Mail.Send is required, one bounded recipient, Reply-To resolved in core, the exact Graph payload, and no token or provider body in any result.
 */
/**
 * Security boundary tests for the fixed Outlook send operation exposed to app packages.
 *
 * The two failure modes that matter: a background job must never send from a mailbox the package
 * did not name exactly, and nothing Microsoft returns (tokens, error bodies) may reach the package.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOutlookMailSender, outlookMailSenderInternals } from '@/app/routes/outlook-mail-sender';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';

const SUB = 'local-info-mailbox-owner';
const BDO = 'local-bdo';

function connection(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connection_id: 'outlook-info',
    user_sub: SUB,
    connected_by_sub: null,
    tenant_id: null,
    provider: 'outlook',
    label: 'info',
    account_key: 'info@gsquaredfunding.com',
    is_default: true,
    account_email: 'info@gsquaredfunding.com',
    account_id: 'entra-object',
    scopes: 'openid profile offline_access Mail.Read Mail.Send',
    access_token: 'encrypted',
    refresh_token: 'encrypted-refresh-sentinel',
    expiry: new Date(Date.now() + 60_000),
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

const bdoConnection = (): ConnectionRow => connection({
  connection_id: 'outlook-bdo', user_sub: BDO, account_email: 'ben@gsquaredfunding.com', account_key: 'ben@gsquaredfunding.com',
});

function graphResponse(status = 202, headers: Record<string, string> = {}): Response {
  return new Response(status === 202 ? null : JSON.stringify({ error: { message: 'secret-provider-detail' } }), { status, headers });
}

const message = { userSub: SUB, loginEmail: 'INFO@gsquaredfunding.com', to: 'owner@carrier.example', subject: 'Heads up', text: 'Hello' };

function sender(rows: Record<string, ConnectionRow[]>, fetchImpl: typeof fetch, token: string | null = 'actor-token') {
  const getAccessToken = vi.fn(async () => token);
  const send = createOutlookMailSender({} as never, {
    listConnections: async (_pool, userSub) => rows[userSub] ?? [],
    getAccessToken,
    fetchImpl,
  });
  return { send, getAccessToken };
}

describe('Outlook sender mailbox selection', () => {
  it('sends only from the exact personal grant the package named, with the Graph payload pinned', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const rows = { [SUB]: [
      connection({ connection_id: 'other', account_email: 'other@gsquaredfunding.com' }),
      connection({ connection_id: 'shared', tenant_id: '11111111-1111-4111-8111-111111111111' }),
      connection(),
    ] };
    const { send, getAccessToken } = sender(rows, fetchImpl);
    await expect(send(message)).resolves.toEqual({ status: 'sent', replyTo: 'none' });
    expect(getAccessToken).toHaveBeenCalledWith(expect.anything(), SUB, 'outlook', { tenantId: 'personal', connectionId: 'outlook-info' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer actor-token');
    expect(JSON.parse(String(init.body))).toEqual({
      message: {
        subject: 'Heads up',
        body: { contentType: 'Text', content: 'Hello' },
        toRecipients: [{ emailAddress: { address: 'owner@carrier.example' } }],
      },
      saveToSentItems: true,
    });
  });

  it('fails closed without a sender address, with no exact match, or with a shared-only grant, and never calls Graph', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const { send, getAccessToken } = sender({ [SUB]: [connection()] }, fetchImpl);
    await expect(send({ ...message, loginEmail: '' })).resolves.toEqual({ status: 'not_connected', replyTo: 'none' });
    await expect(send({ ...message, loginEmail: 'sales@gsquaredfunding.com' })).resolves.toEqual({ status: 'not_connected', replyTo: 'none' });
    const shared = sender({ [SUB]: [connection({ tenant_id: '11111111-1111-4111-8111-111111111111' })] }, fetchImpl);
    await expect(shared.send(message)).resolves.toEqual({ status: 'not_connected', replyTo: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('requires the delegated Mail.Send scope', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const { send } = sender({ [SUB]: [connection({ scopes: 'openid offline_access Mail.Read' })] }, fetchImpl);
    await expect(send(message)).resolves.toEqual({ status: 'missing_scope', replyTo: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outlookMailSenderInternals.hasMailSendScope('https://graph.microsoft.com/Mail.Send')).toBe(true);
  });
});

describe('Outlook sender message bounds', () => {
  it('rejects a bad recipient, an empty subject or an empty body before any provider call', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const { send } = sender({ [SUB]: [connection()] }, fetchImpl);
    await expect(send({ ...message, to: 'owner@carrier.example, second@carrier.example' })).resolves.toMatchObject({ status: 'rejected' });
    await expect(send({ ...message, subject: '  ' })).resolves.toMatchObject({ status: 'rejected' });
    await expect(send({ ...message, text: '' })).resolves.toMatchObject({ status: 'rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('flattens header line breaks out of the subject and sends HTML as the body when given', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const { send } = sender({ [SUB]: [connection()] }, fetchImpl);
    await send({ ...message, subject: 'Heads\r\nBcc: x@y.z\n up', html: '<p>Hello</p>' });
    const body = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.message.subject).toBe('Heads Bcc: x@y.z up');
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>Hello</p>' });
    expect(outlookMailSenderInternals.boundedSubject('a'.repeat(300))).toHaveLength(255);
  });
});

describe('Outlook sender Reply-To and provider outcomes', () => {
  it('resolves Reply-To from the named user\'s own personal grant inside core, and reports unavailable otherwise', async () => {
    const fetchImpl = vi.fn(async () => graphResponse()) as unknown as typeof fetch;
    const { send } = sender({ [SUB]: [connection()], [BDO]: [bdoConnection()] }, fetchImpl);
    await expect(send({ ...message, replyToUserSub: BDO })).resolves.toEqual({ status: 'sent', replyTo: 'set' });
    const body = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.message.replyTo).toEqual([{ emailAddress: { address: 'ben@gsquaredfunding.com' } }]);
    // Two personal grants for the reply user: never guess, send without Reply-To.
    const ambiguous = sender({ [SUB]: [connection()], [BDO]: [bdoConnection(), bdoConnection()] }, fetchImpl);
    await expect(ambiguous.send({ ...message, replyToUserSub: BDO })).resolves.toEqual({ status: 'sent', replyTo: 'unavailable' });
    await expect(ambiguous.send({ ...message, replyToUserSub: 'local-nobody' })).resolves.toEqual({ status: 'sent', replyTo: 'unavailable' });
  });

  it('maps provider refusals to status words and lets nothing of Microsoft\'s reply through', async () => {
    const outcomes: Array<[number, string, Record<string, string>]> = [
      [401, 'reconnect_required', {}], [403, 'reconnect_required', {}], [400, 'rejected', {}],
      [429, 'throttled', { 'retry-after': '17' }], [503, 'throttled', {}], [500, 'unavailable', {}],
    ];
    for (const [status, expected, headers] of outcomes) {
      const fetchImpl = vi.fn(async () => graphResponse(status, headers)) as unknown as typeof fetch;
      const { send } = sender({ [SUB]: [connection()] }, fetchImpl);
      const result = await send(message);
      expect(result.status).toBe(expected);
      if (headers['retry-after']) expect(result.retryAfterSeconds).toBe(17);
      expect(JSON.stringify(result)).not.toMatch(/secret-provider-detail|actor-token|encrypted/);
    }
    const down = sender({ [SUB]: [connection()] }, vi.fn(async () => { throw new Error('ECONNRESET actor-token'); }) as unknown as typeof fetch);
    await expect(down.send(message)).resolves.toEqual({ status: 'unavailable', replyTo: 'none' });
    const refused = sender({ [SUB]: [connection()] }, vi.fn() as unknown as typeof fetch, null);
    await expect(refused.send(message)).resolves.toEqual({ status: 'reconnect_required', replyTo: 'none' });
  });
});
