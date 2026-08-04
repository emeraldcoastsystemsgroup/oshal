/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for scripts/oshal-gmail-send.js SEQ 3 and SEQ 4. (1) BEHAVIOR — the attachment Content-Type is derived from the file, not hardcoded: the CLI was written for the recap-video path and stamped `video/mp4` on EVERY attachment, so the first PDF sent through it went out mislabelled as a video. The test assembles a real message through send() with a stubbed fetch and reads the Content-Type back off the wire, so it fails if the header is ever pinned to a constant again. (2) EXISTENCE — the envelope-crypto unwrap must stay in ONE place: this CLI was the third of three to carry the legacy-only decrypt (oshal-gmail.js SEQ 6, oshal-recap-email.js SEQ 3 were ported, this one was missed and threw uncaught on every send once OSHAL_ENVELOPE_CRYPTO defaulted ON). The drift was caused by copy-paste, so the guard is "no fourth copy": this file must import the sibling's decryptToken and must not build its own decipher. (3) RLS BEHAVIOR (SEQ 4) — oshal_connections is force-RLS, so a connection that sets neither oshal.current_sub nor oshal.is_operator reads zero rows and the CLI reports "no Google connection" on a box with three of them. applyRlsContext is driven against a recording fake client: the sub must be BOUND not interpolated, operator scope must never be taken implicitly, and a caller sub must win over it.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'oshal-gmail-send.js');
const { mimeFor, send, applyRlsContext } = require_(SCRIPT_PATH) as {
  mimeFor: (name: string) => string;
  send: (t: string, a: string, to: string, s: string, b: string, attach?: string) => Promise<void>;
  applyRlsContext: (client: FakeClient, userSub?: string) => Promise<boolean>;
};

/** Records the SQL a client is asked to run, so the GUC calls can be asserted directly. */
type FakeClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: never[] }>; calls: Array<{ sql: string; params?: unknown[] }> };
function fakeClient(): FakeClient {
  const calls: FakeClient['calls'] = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

/**
 * @description Drive send() with a stubbed fetch and hand back the decoded RFC-822 message.
 * Reading the real assembled MIME is what makes this mutation-proof — asserting on mimeFor()
 * alone would still pass if send() stopped calling it.
 * @param attachPath file to attach
 * @returns the decoded message source Gmail would have received
 */
async function capturedMessage(attachPath: string): Promise<string> {
  let raw = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    raw = JSON.parse(init.body).raw;
    return { ok: true, json: async () => ({ id: 'stub-message-id' }) };
  }) as unknown as typeof globalThis.fetch;
  try {
    await send('stub-token', 'sender@example.com', 'rcpt@example.com', 'subject', 'body text', attachPath);
  } finally {
    globalThis.fetch = realFetch;
  }
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const tmpFiles: string[] = [];
/** Write a throwaway attachment with the given extension. */
function tmpAttachment(ext: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-mime-')), `report${ext}`);
  fs.writeFileSync(p, 'attachment bytes');
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  while (tmpFiles.length) {
    const p = tmpFiles.pop()!;
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('oshal-gmail-send attachment Content-Type (BEHAVIOR)', () => {
  it('labels a PDF attachment application/pdf, not video/mp4', async () => {
    const msg = await capturedMessage(tmpAttachment('.pdf'));
    expect(msg).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(msg).not.toContain('video/mp4');
  });

  it('still labels the original recap-video case video/mp4', async () => {
    const msg = await capturedMessage(tmpAttachment('.mp4'));
    expect(msg).toContain('Content-Type: video/mp4; name="report.mp4"');
  });

  it('falls back to application/octet-stream for an unknown extension', async () => {
    const msg = await capturedMessage(tmpAttachment('.qqq'));
    expect(msg).toContain('Content-Type: application/octet-stream; name="report.qqq"');
  });

  it('keeps the attachment disposition and base64 transfer encoding intact', async () => {
    const msg = await capturedMessage(tmpAttachment('.pdf'));
    expect(msg).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(msg).toContain('Content-Transfer-Encoding: base64');
    expect(msg).toContain('Content-Type: multipart/mixed; boundary=');
  });

  it('maps the extensions this swarm actually attaches', () => {
    expect(mimeFor('a.pdf')).toBe('application/pdf');
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.csv')).toBe('text/csv');
    expect(mimeFor('a.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(mimeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('oshal-gmail-send RLS context (BEHAVIOR)', () => {
  const savedOperator = process.env.OSHAL_OPERATOR;
  afterEach(() => {
    if (savedOperator === undefined) delete process.env.OSHAL_OPERATOR;
    else process.env.OSHAL_OPERATOR = savedOperator;
  });

  it('scopes to the caller with oshal.current_sub when a sub is given', async () => {
    const c = fakeClient();
    const operatorWide = await applyRlsContext(c, 'sub-12345');
    expect(operatorWide).toBe(false);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].sql).toContain("set_config('oshal.current_sub'");
    expect(c.calls[0].params).toEqual(['sub-12345']);
    // The sub must be bound, never interpolated into the statement.
    expect(c.calls[0].sql).not.toContain('sub-12345');
  });

  it('never escalates to operator scope implicitly', async () => {
    delete process.env.OSHAL_OPERATOR;
    const c = fakeClient();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exited'); }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(applyRlsContext(c, undefined)).rejects.toThrow('exited');
      expect(exit).toHaveBeenCalledWith(2);
      expect(c.calls.some((q) => q.sql.includes('is_operator'))).toBe(false);
      expect(err.mock.calls.flat().join(' ')).toMatch(/force-RLS/);
    } finally { exit.mockRestore(); err.mockRestore(); }
  });

  it('takes operator scope only when OSHAL_OPERATOR=1 is set explicitly', async () => {
    process.env.OSHAL_OPERATOR = '1';
    const c = fakeClient();
    const operatorWide = await applyRlsContext(c, undefined);
    expect(operatorWide).toBe(true);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].sql).toContain("set_config('oshal.is_operator', 'on'");
  });

  it('prefers the caller sub over operator scope even when both are available', async () => {
    process.env.OSHAL_OPERATOR = '1';
    const c = fakeClient();
    expect(await applyRlsContext(c, 'sub-999')).toBe(false);
    expect(c.calls[0].sql).toContain('current_sub');
    expect(c.calls.some((q) => q.sql.includes('is_operator'))).toBe(false);
  });
});

describe('oshal-gmail-send envelope-crypto reuse (EXISTENCE)', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

  it('imports the shared format-aware decryptToken instead of carrying a copy', () => {
    expect(source).toMatch(/require\(['"]\.\/oshal-gmail['"]\)/);
    expect(source).toMatch(/decryptToken\(client, row\.user_sub, row\.access_token\)/);
    expect(source).toMatch(/decryptToken\(client, row\.user_sub, row\.refresh_token\)/);
  });

  it('does not build its own decipher — a fourth copy is how the drift spread', () => {
    expect(source).not.toMatch(/createDecipheriv/);
  });

  it('runs its queries on a pooled client, not the Pool (set_config is connection-scoped)', () => {
    expect(source).toMatch(/await pool\.connect\(\)/);
    expect(source).toMatch(/getAccessToken\(client\)/);
    expect(source).not.toMatch(/getAccessToken\(pool\)/);
  });

  it('wraps the access_token decrypt in a try/catch so drift falls through to a refresh', () => {
    // The uncaught throw here is what turned format drift into a total send outage: the
    // invariant is that this specific decrypt sits inside a try whose catch does not exit.
    expect(source).toMatch(
      /try \{[\s\S]{0,200}decryptToken\(client, row\.user_sub, row\.access_token\)[\s\S]{0,500}\} catch/,
    );
    expect(source).toMatch(/refreshing via refresh_token/);
  });
});
