/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit coverage for scripts/oshal-outlook.js (ADR-037 Outlook provider): Graph v1.0 request-building (list $top/$filter, read-one URL encoding, sendMail payload shape), Gmail-digest field parity in summarizeOutlookMessage, mocked-fetch mailDigest/sendMail behavior (Bearer header, 202 accept, non-2xx fail-closed), and the credential-free CLI surface (--help exit 0; send without --confirm exits 5 with a machine-readable JSON error before any token/DB access).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review findings (gap-list build 2026-07-15): a missing --body-file fails closed (exit 1 machine-readable JSON, never sends the literal path string as the body), and a body-file path that is a directory (EISDIR) prints the {error, message} JSON contract instead of crashing with a raw stack.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const requireModule = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const OUTLOOK_CLI = path.join(ROOT, 'scripts/oshal-outlook.js');
const outlookCli = requireModule(OUTLOOK_CLI) as {
  GRAPH_BASE: string;
  buildListMessagesUrl(opts?: { top?: number | string; filter?: string }): string;
  buildGetMessageUrl(messageId: string): string;
  buildSendMailPayload(opts: { to: string | string[]; cc?: string | string[]; subject: string; body?: string; contentType?: string }): Record<string, any>;
  summarizeOutlookMessage(m: Record<string, unknown> | null): Record<string, any>;
  mailDigest(token: string, opts?: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<Record<string, any>[]>;
  sendMail(token: string, payload: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<{ status: number }>;
  parseCliArgs(argv: string[]): Record<string, any>;
};

let isolatedCwd = '';

beforeAll(async () => {
  // Run the subprocess cases from an empty cwd so no stray .oshal-cred-outlook /
  // .oshal-user-sub file from the repo tree can leak a credential into the test.
  isolatedCwd = await mkdtemp(path.join(tmpdir(), 'oshal-outlook-test-'));
});

afterAll(async () => {
  if (isolatedCwd) await rm(isolatedCwd, { recursive: true, force: true });
});

/** Run the CLI with a credential-free env; resolves even on non-zero exit. */
async function runOutlookCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.OSHAL_CRED_OUTLOOK;
  delete env.OSHAL_USER_SUB;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [OUTLOOK_CLI, ...args], {
      cwd: isolatedCwd, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

describe('oshal-outlook request building (Microsoft Graph v1.0)', () => {
  it('lists messages via GET /me/messages with a clamped $top and the digest $select', () => {
    const url = new URL(outlookCli.buildListMessagesUrl({ top: 25 }));
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(url.searchParams.get('$top')).toBe('25');
    expect(url.searchParams.get('$select')).toContain('id');
    expect(url.searchParams.get('$select')).toContain('isRead');
    expect(url.searchParams.get('$select')).toContain('receivedDateTime');
    expect(url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(url.searchParams.get('$filter')).toBeNull();
  });

  it('passes $filter through verbatim and drops $orderby (Graph rejects the combination)', () => {
    const url = new URL(outlookCli.buildListMessagesUrl({ top: 10, filter: 'isRead eq false' }));
    expect(url.searchParams.get('$filter')).toBe('isRead eq false');
    expect(url.searchParams.get('$orderby')).toBeNull();
    expect(url.searchParams.get('$top')).toBe('10');
  });

  it('clamps $top into the 1..100 Graph page-size range and defaults to 25', () => {
    expect(new URL(outlookCli.buildListMessagesUrl({ top: 5000 })).searchParams.get('$top')).toBe('100');
    expect(new URL(outlookCli.buildListMessagesUrl({ top: 0 })).searchParams.get('$top')).toBe('25');
    expect(new URL(outlookCli.buildListMessagesUrl()).searchParams.get('$top')).toBe('25');
  });

  it('reads one message via GET /me/messages/{id} with the id URL-encoded (Graph ids carry = and /)', () => {
    const url = outlookCli.buildGetMessageUrl('AAMkAGI2/Tm9=');
    expect(url.startsWith('https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2%2FTm9%3D?')).toBe(true);
    expect(url).toContain('body');
    expect(() => outlookCli.buildGetMessageUrl('')).toThrow('message id');
  });

  it('builds the real POST /me/sendMail payload shape (message + saveToSentItems)', () => {
    const payload = outlookCli.buildSendMailPayload({
      to: 'a@example.com, b@example.com', cc: ['c@example.com'], subject: 'Hi', body: 'Body text',
    });
    expect(payload).toEqual({
      message: {
        subject: 'Hi',
        body: { contentType: 'Text', content: 'Body text' },
        toRecipients: [
          { emailAddress: { address: 'a@example.com' } },
          { emailAddress: { address: 'b@example.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'c@example.com' } }],
      },
      saveToSentItems: true,
    });
    expect(() => outlookCli.buildSendMailPayload({ to: '', subject: 'x' })).toThrow('recipient');
    expect(() => outlookCli.buildSendMailPayload({ to: 'a@example.com', subject: '' })).toThrow('subject');
  });
});

describe('oshal-outlook digest parity with the Gmail contract', () => {
  it('maps a Graph message onto the Gmail digest field names (id/from/subject/receivedAt/providerFlags)', () => {
    const row = outlookCli.summarizeOutlookMessage({
      id: 'msg-1',
      subject: 'Quarterly numbers',
      from: { emailAddress: { name: 'Dana Ops', address: 'dana@example.com' } },
      receivedDateTime: '2026-07-15T12:00:00Z',
      bodyPreview: 'Here are the numbers…',
      isRead: false,
      importance: 'high',
      flag: { flagStatus: 'flagged' },
    });
    expect(row).toMatchObject({
      id: 'msg-1',
      from: 'Dana Ops',
      subject: 'Quarterly numbers',
      receivedAt: '2026-07-15T12:00:00Z',
      snippet: 'Here are the numbers…',
      unread: true,
      important: true,
      starred: true,
      providerFlags: { unread: true, important: true, starred: true },
    });
  });

  it('defaults safely on sparse messages (read mail is not unread; no subject placeholder)', () => {
    const row = outlookCli.summarizeOutlookMessage({ id: 'msg-2', isRead: true });
    expect(row.subject).toBe('(no subject)');
    expect(row.unread).toBe(false);
    expect(row.important).toBe(false);
    expect(row.starred).toBe(false);
  });

  it('fetches the list with the Bearer token and maps rows (HTTP layer mocked)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      value: [{ id: 'm1', subject: 'One', isRead: false, receivedDateTime: '2026-07-15T01:00:00Z' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const rows = await outlookCli.mailDigest('tok-123', { top: 5 }, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toContain('https://graph.microsoft.com/v1.0/me/messages?');
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', subject: 'One', unread: true });
  });

  it('fails closed on a non-OK Graph response instead of returning fake data', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }));
    await expect(outlookCli.mailDigest('tok-123', {}, fetchImpl as unknown as typeof fetch))
      .rejects.toThrow('Graph API 403');
  });
});

describe('oshal-outlook sendMail', () => {
  it('POSTs the payload to /me/sendMail and accepts Graph\'s empty 202', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const payload = outlookCli.buildSendMailPayload({ to: 'a@example.com', subject: 'Hi', body: 'B' });

    const result = await outlookCli.sendMail('tok-123', payload, fetchImpl as unknown as typeof fetch);

    expect(result.status).toBe(202);
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(requestInit.method).toBe('POST');
    expect((requestInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(requestInit.body))).toEqual(payload);
  });

  it('throws on a Graph rejection (e.g. 403 missing Mail.Send) instead of claiming success', async () => {
    const fetchImpl = vi.fn(async () => new Response('ErrorAccessDenied', { status: 403 }));
    const payload = outlookCli.buildSendMailPayload({ to: 'a@example.com', subject: 'Hi' });
    await expect(outlookCli.sendMail('tok-123', payload, fetchImpl as unknown as typeof fetch))
      .rejects.toThrow('sendMail rejected: 403');
  });
});

describe('oshal-outlook CLI surface (no credentials required)', () => {
  it('--help prints usage and exits 0 without any credential or DB access', async () => {
    const result = await runOutlookCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/oshal-outlook.js');
    expect(result.stdout).toContain('send <to> <subject>');
    expect(result.stdout).toContain('--filter');
  });

  it('refuses send without --confirm (exit 5, machine-readable error) before touching any token', async () => {
    const result = await runOutlookCli(['send', 'a@example.com', 'Subject', 'body text']);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ error: 'confirm_required' });
  });

  it('rejects send with missing recipient/subject as bad_arguments (exit 1)', async () => {
    const result = await runOutlookCli(['send', '--confirm']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ error: 'bad_arguments' });
  });

  it('fails closed on a missing --body-file (exit 1 JSON) instead of sending the literal path as the body', async () => {
    const missing = path.join(isolatedCwd, 'no-such-draft.txt');
    const result = await runOutlookCli(['send', 'a@example.com', 'Subject', '--body-file', missing, '--confirm']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ error: 'bad_arguments' });
    expect(result.stdout).not.toContain('"sent"');
  });

  it('prints machine-readable JSON (not a raw stack) when a body-file path is a directory (EISDIR)', async () => {
    // isolatedCwd is an existing directory: existsSync passes, readFileSync throws EISDIR.
    const result = await runOutlookCli(['send', 'a@example.com', 'Subject', isolatedCwd, '--confirm']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ error: 'bad_arguments' });
  });

  it('parses flags and positionals per the documented contract', () => {
    const args = outlookCli.parseCliArgs(['list', '--top', '10', '--filter', 'isRead eq false']);
    expect(args).toMatchObject({ cmd: 'list', top: '10', filter: 'isRead eq false' });
    const send = outlookCli.parseCliArgs(['send', '--to', 'a@b.c', '--subject', 'S', '--body', 'B', '--confirm']);
    expect(send).toMatchObject({ cmd: 'send', to: 'a@b.c', subject: 'S', body: 'B', confirm: true });
    const digest = outlookCli.parseCliArgs([]);
    expect(digest.cmd).toBe('digest');
  });
});
