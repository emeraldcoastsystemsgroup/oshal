import { describe, it, expect } from 'vitest';
import {
  forwarderConfig,
  formatJsonLine,
  formatSyslog,
  forwardAuditEvent,
  type ForwardableAuditEvent,
  type FetchLike,
} from './forwarder';

const evt: ForwardableAuditEvent = {
  actorSub: 'user-1',
  action: 'ticket.access',
  resourceType: 'ticket',
  resourceId: 't-42',
  decision: 'deny',
  timestamp: '2026-06-21T12:00:00.000Z',
};

describe('forwarderConfig — disabled unless URL set', () => {
  it('disabled with no URL', () => {
    expect(forwarderConfig({} as never).enabled).toBe(false);
  });
  it('enabled + defaults to json', () => {
    const c = forwarderConfig({ OSHAL_AUDIT_FORWARD_URL: 'https://siem.example/collect' } as never);
    expect(c.enabled).toBe(true);
    expect(c.format).toBe('json');
  });
  it('honors syslog format + token', () => {
    const c = forwarderConfig({
      OSHAL_AUDIT_FORWARD_URL: 'https://siem.example/collect',
      OSHAL_AUDIT_FORWARD_FORMAT: 'syslog',
      OSHAL_AUDIT_FORWARD_TOKEN: 'secret',
    } as never);
    expect(c.format).toBe('syslog');
    expect(c.token).toBe('secret');
  });
});

describe('formatters', () => {
  it('formatJsonLine emits a single parseable JSON line with the fields', () => {
    const line = formatJsonLine(evt);
    expect(line).not.toContain('\n');
    const o = JSON.parse(line);
    expect(o).toMatchObject({ actor: 'user-1', action: 'ticket.access', decision: 'deny', resourceId: 't-42' });
  });
  it('formatSyslog encodes severity (deny=warning) + structured data', () => {
    const s = formatSyslog(evt);
    // facility 13*8 + severity 4 (warning) = 108
    expect(s.startsWith('<108>1 ')).toBe(true);
    expect(s).toContain('action="ticket.access"');
    expect(s).toContain('decision="deny"');
  });
  it('formatSyslog uses informational severity for allow', () => {
    const s = formatSyslog({ ...evt, decision: 'allow' });
    expect(s.startsWith('<110>1 ')).toBe(true); // 13*8 + 6
  });
});

describe('forwardAuditEvent — best-effort, injectable fetch', () => {
  it('no-op (false) when disabled', async () => {
    let called = false;
    const fetch: FetchLike = async () => { called = true; return { ok: true, status: 200 }; };
    const ok = await forwardAuditEvent(evt, { fetch, env: {} as never });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it('POSTs to the endpoint with bearer token when enabled, returns true on 2xx', async () => {
    const seen: { url?: string; init?: Parameters<FetchLike>[1] } = {};
    const fetch: FetchLike = async (url, init) => { seen.url = url; seen.init = init; return { ok: true, status: 200 }; };
    const ok = await forwardAuditEvent(evt, {
      fetch,
      env: { OSHAL_AUDIT_FORWARD_URL: 'https://siem.example/collect', OSHAL_AUDIT_FORWARD_TOKEN: 'tkn' } as never,
    });
    expect(ok).toBe(true);
    expect(seen.url).toBe('https://siem.example/collect');
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.headers.Authorization).toBe('Bearer tkn');
  });

  it('swallows fetch errors and returns false (never throws into the caller)', async () => {
    const fetch: FetchLike = async () => { throw new Error('collector down'); };
    const ok = await forwardAuditEvent(evt, {
      fetch,
      env: { OSHAL_AUDIT_FORWARD_URL: 'https://siem.example/collect' } as never,
    });
    expect(ok).toBe(false);
  });
});
