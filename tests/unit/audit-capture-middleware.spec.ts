import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  deriveAuditTarget,
  shouldCapture,
  decisionFor,
  createAuditCaptureMiddleware,
} from '../../src/features/governance/audit/audit-capture-middleware';

describe('audit-capture: deriveAuditTarget', () => {
  it('derives resource, id, and dotted action from method + path', () => {
    expect(deriveAuditTarget('POST', '/api/tickets')).toEqual({ resourceType: 'tickets', resourceId: null, action: 'tickets.create' });
    expect(deriveAuditTarget('PUT', '/api/tickets/1c2e/status')).toMatchObject({ resourceType: 'tickets', action: 'tickets.update' });
    const uuid = '2ea17142-cf8e-4f91-a43c-eebf58169310';
    expect(deriveAuditTarget('DELETE', `/api/swarm/apps/${uuid}`)).toEqual({ resourceType: 'swarm', resourceId: uuid, action: 'swarm.delete' });
    expect(deriveAuditTarget('GET', '/api/vault/secret/42')).toEqual({ resourceType: 'vault', resourceId: '42', action: 'vault.read' });
  });
});

describe('audit-capture: shouldCapture', () => {
  it('captures every mutating /api request', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(shouldCapture(m, '/api/tickets')).toBe(true);
    }
  });
  it('captures GET only on sensitive-read prefixes', () => {
    expect(shouldCapture('GET', '/api/vault/x')).toBe(true);
    expect(shouldCapture('GET', '/api/connect/list')).toBe(true);
    expect(shouldCapture('GET', '/api/tickets')).toBe(false); // routine read — not recorded
  });
  it('skips health, high-frequency, and audit-log-read paths', () => {
    expect(shouldCapture('GET', '/api/health')).toBe(false);
    expect(shouldCapture('POST', '/api/health/x')).toBe(false);
    expect(shouldCapture('GET', '/api/queue-health')).toBe(false);
    expect(shouldCapture('GET', '/api/audit/log')).toBe(false); // reading the log is not itself audited here
    expect(shouldCapture('POST', '/cockpit/thing')).toBe(false); // non-/api
  });
  it('skips machine heartbeat/register (dynamic id) but keeps the action on the same prefix', () => {
    expect(shouldCapture('POST', '/api/remote-clients/abc-123/heartbeat')).toBe(false); // noise
    expect(shouldCapture('POST', '/api/remote-clients/register')).toBe(false);           // noise
    expect(shouldCapture('POST', '/api/remote-clients/abc-123/tasks')).toBe(true);        // real shell.exec dispatch
  });
});

describe('audit-capture: decisionFor', () => {
  it('maps status to allow/deny/info', () => {
    expect(decisionFor(200)).toBe('allow');
    expect(decisionFor(201)).toBe('allow');
    expect(decisionFor(401)).toBe('deny');
    expect(decisionFor(403)).toBe('deny');
    expect(decisionFor(428)).toBe('deny'); // risky-write confirm guard
    expect(decisionFor(429)).toBe('deny');
    expect(decisionFor(500)).toBe('info');
  });
});

describe('audit-capture: middleware', () => {
  function fakeRes(status: number) {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = status;
    return res;
  }

  it('records a mutating request to access_audit_log on finish, with actor + decision', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = { query: vi.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params: params || [] }); return { rows: [] }; }) };
    const mw = createAuditCaptureMiddleware(pool as never);

    const req = { method: 'POST', path: '/api/tickets', oidc: { user: { sub: 'user-1' } } };
    const res = fakeRes(201);
    const next = vi.fn();
    mw(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1); // request is never delayed

    res.emit('finish');
    await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget insert run

    const insert = calls.find((c) => /INSERT INTO access_audit_log/i.test(c.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params[0]).toBe('user-1');        // actorSub
    expect(insert!.params[1]).toBe('tickets.create'); // action
    expect(insert!.params[4]).toBe('allow');          // decision (201)
  });

  it('does not record a routine GET, and does not double-record on finish+close', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const mw = createAuditCaptureMiddleware(pool as never);

    // routine GET — skipped entirely
    const res1 = fakeRes(200);
    mw({ method: 'GET', path: '/api/tickets' } as never, res1 as never, vi.fn());
    res1.emit('finish');

    // mutating request — recorded exactly once even if both finish and close fire
    const res2 = fakeRes(403);
    mw({ method: 'DELETE', path: '/api/swarm/apps/x', oidc: { user: { sub: 's' } } } as never, res2 as never, vi.fn());
    res2.emit('finish');
    res2.emit('close');
    await new Promise((r) => setTimeout(r, 5));

    const inserts = pool.query.mock.calls.filter((c) => /INSERT INTO access_audit_log/i.test(String(c[0])));
    expect(inserts.length).toBe(1); // one insert total: the GET was skipped, the delete recorded once
  });
});
