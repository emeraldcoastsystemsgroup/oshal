/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security boundary guards for the fixed Outlook participant reader (mailbox selection fail-closed, scope checks, participant re-validation, PII minimization).
 */
/**
 * Security boundary tests for the fixed Outlook participant reader exposed to app packages.
 *
 * These guards pin the two easy-to-miss failure modes: connector resolution must never drift to
 * a shared/different mailbox, and Microsoft Search is only an optimization—the returned message
 * still needs an exact authorized participant before any metadata reaches the package.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createOutlookMailReader, outlookMailReaderInternals,
} from '@/app/routes/outlook-mail-reader';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';

const SUB = 'local-current-user';

function connection(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connection_id: 'outlook-current',
    user_sub: SUB,
    connected_by_sub: null,
    tenant_id: null,
    provider: 'outlook',
    label: 'work',
    account_key: 'me@gsquaredfunding.com',
    is_default: true,
    account_email: 'me@gsquaredfunding.com',
    account_id: 'entra-object',
    scopes: 'openid profile offline_access Mail.Read',
    access_token: 'encrypted',
    refresh_token: 'encrypted-refresh-sentinel',
    expiry: new Date(Date.now() + 60_000),
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function reader(rows: ConnectionRow[], fetchImpl: typeof fetch, token: string | null = 'actor-token') {
  return createOutlookMailReader({} as never, {
    listConnections: async () => rows,
    getAccessToken: async () => token,
    fetchImpl,
  });
}

describe('Outlook actor-mailbox selection', () => {
  it('selects the exact verified login mailbox and never a shared or different personal grant', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    const getToken = vi.fn(async () => 'actor-token');
    const rows = [
      connection({ connection_id: 'other', account_email: 'other@gsquaredfunding.com' }),
      connection({ connection_id: 'shared', tenant_id: '11111111-1111-4111-8111-111111111111' }),
      connection(),
    ];
    const read = createOutlookMailReader({} as never, {
      listConnections: async () => rows,
      getAccessToken: getToken,
      fetchImpl,
    });
    await read({
      userSub: SUB,
      loginEmail: 'ME@gsquaredfunding.com',
      matchAddresses: ['customer@example.com'],
    });
    expect(getToken).toHaveBeenCalledWith(expect.anything(), SUB, 'outlook', {
      tenantId: 'personal', connectionId: 'outlook-current',
    });
  });

  it('fails closed when the login email has no exact personal connector or email-less selection is ambiguous', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    const rows = [connection(), connection({ connection_id: 'second', account_email: 'second@example.com' })];
    await expect(reader(rows, fetchImpl)({
      userSub: SUB, loginEmail: 'unknown@example.com', matchAddresses: ['customer@example.com'],
    })).resolves.toEqual({ status: 'not_connected', emails: [] });
    await expect(reader([connection()], fetchImpl)({
      userSub: SUB, loginEmail: 'malformed identity', matchAddresses: ['customer@example.com'],
    })).resolves.toEqual({ status: 'not_connected', emails: [] });
    await expect(reader(rows, fetchImpl)({
      userSub: SUB, matchAddresses: ['customer@example.com'],
    })).resolves.toEqual({ status: 'not_connected', emails: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires delegated Mail.Read rather than treating login-only scopes as mailbox access', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [] })) as unknown as typeof fetch;
    await expect(reader([connection({ scopes: 'openid profile email' })], fetchImpl)({
      userSub: SUB,
      loginEmail: 'me@gsquaredfunding.com',
      matchAddresses: ['customer@example.com'],
    })).resolves.toEqual({ status: 'missing_scope', emails: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Outlook participant filtering and response minimization', () => {
  it('rechecks exact participants and returns only bounded preview metadata, not full body/recipients/mailbox', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      value: [
        {
          id: 'inbound-1',
          subject: 'Funding documents',
          from: { emailAddress: { name: 'Client Contact', address: 'client@example.com' } },
          toRecipients: [{ emailAddress: { address: 'me@gsquaredfunding.com' } }],
          ccRecipients: [{ emailAddress: { address: 'unrelated@example.net' } }],
          receivedDateTime: '2026-08-17T15:00:00Z',
          bodyPreview: 'The signed packet is attached.',
          body: { content: 'MUST NEVER LEAVE CORE' },
          isRead: false,
          webLink: 'https://outlook.office365.com/owa/?ItemID=abc',
        },
        {
          // Deliberate Microsoft Search false positive: exact participant validation must drop it.
          id: 'false-positive',
          subject: 'client@example.com appeared only as text',
          from: { emailAddress: { address: 'stranger@example.net' } },
          toRecipients: [{ emailAddress: { address: 'me@gsquaredfunding.com' } }],
          receivedDateTime: '2026-08-17T16:00:00Z',
          bodyPreview: 'client@example.com',
        },
      ],
    })) as unknown as typeof fetch;

    const result = await reader([connection()], fetchImpl)({
      userSub: SUB,
      loginEmail: 'me@gsquaredfunding.com',
      matchAddresses: [
        ' CLIENT@example.com ', 'not-an-email', 'client@example.com', 'client2@example.com',
        // A bad CRM row containing the rep's own address must not search the entire mailbox.
        'me@gsquaredfunding.com',
      ],
      limit: 50,
    });

    expect(result.status).toBe('connected');
    expect(result.emails).toEqual([{
      id: 'inbound-1',
      subject: 'Funding documents',
      sentAt: '2026-08-17T15:00:00Z',
      direction: 'inbound',
      preview: 'The signed packet is attached.',
      isRead: false,
      webUrl: 'https://outlook.office365.com/owa/?ItemID=abc',
      counterpart: { name: 'Client Contact', address: 'client@example.com' },
      matchedAddress: 'client@example.com',
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('MUST NEVER LEAVE CORE');
    expect(serialized).not.toContain('unrelated@example.net');
    expect(serialized).not.toContain('me@gsquaredfunding.com');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('$search')).toBe(
      '"participants:client@example.com" OR "participants:client2@example.com"',
    );
    expect(String((init as RequestInit).headers && JSON.stringify((init as RequestInit).headers)))
      .not.toContain('unrelated@example.net');
  });

  it('classifies mail sent by the selected mailbox as outbound and rejects non-Outlook deep links', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [{
      id: 'sent-1',
      subject: 'Checking in',
      from: { emailAddress: { address: 'me@gsquaredfunding.com' } },
      toRecipients: [{ emailAddress: { name: 'Client', address: 'client@example.com' } }],
      sentDateTime: '2026-08-17T18:00:00Z',
      bodyPreview: 'Call me when convenient.',
      webLink: 'https://evil.example/phish',
    }] })) as unknown as typeof fetch;
    const result = await reader([connection()], fetchImpl)({
      userSub: SUB, loginEmail: 'me@gsquaredfunding.com', matchAddresses: ['client@example.com'],
    });
    expect(result.emails[0]).toMatchObject({
      direction: 'outbound',
      counterpart: { name: 'Client', address: 'client@example.com' },
      matchedAddress: 'client@example.com',
    });
    expect(result.emails[0]).not.toHaveProperty('webUrl');
  });

  it('keeps inbound group sender truthful, tracks the matched CRM address separately, and excludes drafts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [
      {
        id: 'group-1',
        subject: 'Shared thread',
        from: { emailAddress: { name: 'Actual Sender', address: 'sender@example.net' } },
        toRecipients: [{ emailAddress: { address: 'me@gsquaredfunding.com' } }],
        ccRecipients: [{ emailAddress: { name: 'CRM Client', address: 'client@example.com' } }],
        receivedDateTime: '2026-08-17T19:00:00Z',
        isDraft: false,
      },
      {
        id: 'draft-1',
        subject: 'Never sent',
        from: { emailAddress: { address: 'me@gsquaredfunding.com' } },
        toRecipients: [{ emailAddress: { address: 'client@example.com' } }],
        sentDateTime: '2026-08-17T20:00:00Z',
        isDraft: true,
      },
    ] })) as unknown as typeof fetch;
    const result = await reader([connection()], fetchImpl)({
      userSub: SUB, loginEmail: 'me@gsquaredfunding.com', matchAddresses: ['client@example.com'],
    });
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]).toMatchObject({
      id: 'group-1',
      direction: 'inbound',
      counterpart: { name: 'Actual Sender', address: 'sender@example.net' },
      matchedAddress: 'client@example.com',
    });
    expect(JSON.stringify(result)).not.toContain('Never sent');
  });

  it('maps authorization loss separately from a transient provider failure', async () => {
    const unauthorized = vi.fn(async () => jsonResponse({ error: {} }, 401)) as unknown as typeof fetch;
    const unavailable = vi.fn(async () => jsonResponse({ error: {} }, 503)) as unknown as typeof fetch;
    const input = {
      userSub: SUB, loginEmail: 'me@gsquaredfunding.com', matchAddresses: ['client@example.com'],
    };
    await expect(reader([connection()], unauthorized)(input))
      .resolves.toEqual({ status: 'reconnect_required', emails: [] });
    await expect(reader([connection()], unavailable)(input))
      .resolves.toEqual({ status: 'unavailable', emails: [] });
  });

  it('deduplicates, sorts, enforces the requested result cap, and tolerates malformed empty payloads', async () => {
    const message = (id: string, at: string) => ({
      id,
      subject: id,
      from: { emailAddress: { address: 'client@example.com' } },
      toRecipients: [{ emailAddress: { address: 'me@gsquaredfunding.com' } }],
      receivedDateTime: at,
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ value: [
      message('old', '2026-08-17T10:00:00Z'),
      message('new', '2026-08-17T12:00:00Z'),
      message('middle', '2026-08-17T11:00:00Z'),
      message('new', '2026-08-17T12:00:00Z'),
    ] })) as unknown as typeof fetch;
    const input = {
      userSub: SUB,
      loginEmail: 'me@gsquaredfunding.com',
      matchAddresses: ['client@example.com'],
      limit: 2,
    };
    const result = await reader([connection()], fetchImpl)(input);
    expect(result.emails.map((row) => row.id)).toEqual(['new', 'middle']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const malformed = vi.fn(async () => jsonResponse({ value: { not: 'an array' } })) as unknown as typeof fetch;
    await expect(reader([connection()], malformed)(input))
      .resolves.toEqual({ status: 'connected', emails: [] });
  });
});

describe('Outlook reader pure guards', () => {
  it('caps the Graph query and rejects query-expression characters in addresses', () => {
    expect(outlookMailReaderInternals.normalizeAddress('a@example.com')).toBe('a@example.com');
    expect(outlookMailReaderInternals.normalizeAddress('a@example.com" OR from:x')).toBeNull();
    const url = new URL(outlookMailReaderInternals.graphSearchUrl(['a@example.com', 'b@example.com'], 50));
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(url.searchParams.get('$top')).toBe('50');
    expect(url.searchParams.get('$search')).toBe('"participants:a@example.com" OR "participants:b@example.com"');
  });
});
