/**
 * Connector write-action guards — the bespoke LinkedIn publish, and the audit trail you can read.
 *
 * WHY THIS EXISTS: `linkedin-assistant-routes` published to /v2/ugcPosts with a bare fetch(). It was
 * not a regression (it matched the pre-existing pattern) but it meant a PUBLIC post made on someone's
 * behalf left no record: no declared params, no shared confirm gate, and nothing in
 * `connector_action_audit`. The distinguishing property of the executor is that it is FAIL-CLOSED on
 * the audit trail — the 'attempt' row must persist BEFORE the provider call — so the guard below
 * proves the write goes through it by making the audit insert fail and asserting NO provider call
 * happens. A bespoke fetch would post anyway. That is behaviour, not a substring.
 *
 * The other half: the trail had no reader, so the approval gate was a promise nobody could check.
 * `GET /api/connectors/actions/audit` is caller-scoped by construction and these guards pin that the
 * caller's sub is bound into the predicate and can never come from request data.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — bespoke-write-goes-through-executor (audit-down refuses the post, both audit rows land, params hash matches, skip paths preserved), the declared-action confirm gate, and the caller-scoped audit read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { buildPublisher } from '../../../src/app/routes/linkedin-assistant-routes';
import { loadConnectorSpec } from '../../../src/app/connectors/runtime/spec';
import { hashConnectorActionParams, runConnectorAction } from '../../../src/app/connectors/runtime/action-executor';
import { readConnectorActionAudit } from '../../../src/app/routes/connector-action-audit';
import { encryptToken } from '../../../src/app/routes/connector-token-crypto';

const SUB = 'auth0|publisher';
const LINKEDIN_SPEC = path.join(process.cwd(), 'swarm-apps/connectors/linkedin.yaml');

interface AuditInsert { sql: string; params: unknown[] }

/**
 * A pool that answers the LinkedIn connection lookup with a REALLY encrypted brokered token (the
 * publisher resolves its credential through getValidAccessToken, so a fake blob would fail before the
 * behaviour under test), serves the per-user DEK table from memory, and records audit inserts.
 * `auditFails` makes every audit INSERT throw — the fail-closed condition.
 */
async function poolFor(opts: { connected?: boolean; accountId?: string | null; auditFails?: boolean } = {}) {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'write-action-guard-secret';
  const inserts: AuditInsert[] = [];
  const deks = new Map<string, string>();
  let connections: Array<Record<string, unknown>> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/FROM oshal_user_deks/i.test(sql)) {
        const wrapped = deks.get(String(params[0]));
        return { rows: wrapped ? [{ wrapped_dek: wrapped }] : [] };
      }
      if (/INSERT INTO oshal_user_deks/i.test(sql)) {
        if (!deks.has(String(params[0]))) deks.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (/connector_action_audit/i.test(sql)) {
        if (opts.auditFails) throw new Error('audit table unavailable');
        if (/^\s*INSERT/i.test(sql)) inserts.push({ sql, params });
        return { rows: [] };
      }
      if (/FROM oshal_tenant_memberships/i.test(sql)) return { rows: [] };
      if (/FROM oshal_connections/i.test(sql)) return { rows: connections };
      return { rows: [] };
    },
  };
  if (opts.connected !== false) {
    const encAccess = await encryptToken(pool as never, SUB, 'brokered-linkedin-token');
    connections = [{
      connection_id: 'conn-li', user_sub: SUB, connected_by_sub: null, tenant_id: null,
      provider: 'linkedin', label: 'me', account_key: 'li-123', is_default: true,
      account_email: 'me@example.com',
      account_id: opts.accountId === undefined ? 'li-123' : opts.accountId,
      scopes: 'w_member_social', access_token: encAccess, refresh_token: null,
      expiry: new Date(Date.now() + 3_600_000), created_at: new Date('2026-01-01T00:00:00Z'),
    }];
  }
  return { pool, inserts };
}

/** The publisher resolves its token through getValidAccessToken, which reads the connection row. */
function ctxFor(pool: unknown) {
  return { pool } as never;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('bespoke-write-goes-through-executor', () => {
  it('REFUSES to publish when the audit trail is unavailable — and calls no provider at all', async () => {
    vi.stubEnv('SESSION_SECRET', 'write-action-guard-secret');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { pool } = await poolFor({ auditFails: true });
    const outcome = await buildPublisher(ctxFor(pool))(SUB, 'a post nobody should see');
    expect(outcome.ok).toBe(false);
    // The whole point: a provider mutation with no persistent record is worse than a refused one.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome.message).toMatch(/audit trail unavailable/i);
  });

  it('writes an attempt row AND a terminal row, hashing the exact params it sent', async () => {
    vi.stubEnv('SESSION_SECRET', 'write-action-guard-secret');
    const posted: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string } = {}) => {
      posted.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ id: 'urn:li:share:999' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const { pool, inserts } = await poolFor();
    const outcome = await buildPublisher(ctxFor(pool))(SUB, 'hello world');
    expect(outcome.ok).toBe(true);
    expect(outcome.postId).toBe('urn:li:share:999');

    // One 'attempt' row before the call, one 'success' row after — both for the declared action.
    const statuses = inserts.map((i) => i.params[5]);
    expect(statuses).toEqual(['attempt', 'success']);
    expect(inserts.every((i) => i.params[1] === 'linkedin' && i.params[2] === 'create-post')).toBe(true);
    expect(inserts.every((i) => i.params[0] === SUB)).toBe(true);
    expect(inserts.every((i) => i.params[4] === 'high')).toBe(true);

    // The hash is of the params actually sent, and the post text is NEVER stored raw.
    const expectedHash = hashConnectorActionParams({
      author: 'urn:li:person:li-123',
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: 'hello world' }, shareMediaCategory: 'NONE' } },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    });
    expect(inserts[0].params[3]).toBe(expectedHash);
    expect(JSON.stringify(inserts.map((i) => i.params))).not.toContain('hello world');

    // And it really did hit the declared endpoint with the declared body.
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://api.linkedin.com/v2/ugcPosts');
    expect(posted[0].body).toMatchObject({ author: 'urn:li:person:li-123', lifecycleState: 'PUBLISHED' });
  });

  it('keeps the clean no-connection SKIP — never a faked success, never an audit row', async () => {
    vi.stubEnv('SESSION_SECRET', 'write-action-guard-secret');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { pool, inserts } = await poolFor({ connected: false });
    const outcome = await buildPublisher(ctxFor(pool))(SUB, 'text');
    expect(outcome).toMatchObject({ ok: false, skipped: true, code: 409 });
    expect(outcome.message).toMatch(/Connect LinkedIn/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('skips distinctly when the connection has no author id', async () => {
    vi.stubEnv('SESSION_SECRET', 'write-action-guard-secret');
    vi.stubGlobal('fetch', vi.fn());
    const { pool } = await poolFor({ accountId: null });
    const outcome = await buildPublisher(ctxFor(pool))(SUB, 'text');
    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(outcome.message).toMatch(/Reconnect LinkedIn/);
  });

  it('surfaces a provider rejection as a failure, with a terminal error row', async () => {
    vi.stubEnv('SESSION_SECRET', 'write-action-guard-secret');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 422 })));
    const { pool, inserts } = await poolFor();
    const outcome = await buildPublisher(ctxFor(pool))(SUB, 'text');
    expect(outcome.ok).toBe(false);
    expect(inserts.map((i) => i.params[5])).toEqual(['attempt', 'error']);
  });
});

describe('the declared LinkedIn action is confirm-gated', () => {
  it('refuses an unconfirmed call with 428 and never resolves a credential', async () => {
    const spec = loadConnectorSpec(LINKEDIN_SPEC);
    const resolveCreds = vi.fn(async () => ({}));
    const inserts: AuditInsert[] = [];
    const result = await runConnectorAction({
      pool: { query: async (sql: string, params: unknown[] = []) => { inserts.push({ sql, params }); return {}; } },
      spec,
      resolveCreds,
      userSub: SUB,
      actionName: 'create-post',
      params: {
        author: 'urn:li:person:li-123', lifecycleState: 'PUBLISHED',
        specificContent: {}, visibility: {},
      },
      requestBody: {},
      fetchImpl: vi.fn() as never,
    });
    expect(result.status).toBe(428);
    expect(resolveCreds).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.params[5] === 'confirmation_required')).toBe(true);
  });

  it('rejects params that violate the declared schema before any credential or HTTP work', async () => {
    const spec = loadConnectorSpec(LINKEDIN_SPEC);
    const resolveCreds = vi.fn(async () => ({}));
    const result = await runConnectorAction({
      pool: { query: async () => ({}) },
      spec,
      resolveCreds,
      userSub: SUB,
      actionName: 'create-post',
      params: { author: 'not-a-urn', lifecycleState: 'DRAFT' },
      requestBody: { confirm: true },
      fetchImpl: vi.fn() as never,
    });
    expect(result.status).toBe(400);
    expect(resolveCreds).not.toHaveBeenCalled();
  });
});

describe('the connector action trail is readable and caller-scoped', () => {
  it('binds the caller sub as $1 and never accepts one from elsewhere', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        return { rows: [{ connector_id: 'linkedin', action: 'create-post', params_hash: 'h', risk_level: 'high', status: 'success', http_status: 201, error: null, ts: new Date('2026-08-01T00:00:00Z') }] };
      },
    };
    const result = await readConnectorActionAudit(pool, SUB, { connectorId: 'linkedin', status: 'success', limit: 5 });
    expect(seen[0].sql).toMatch(/WHERE user_sub = \$1/);
    expect(seen[0].params[0]).toBe(SUB);
    expect(seen[0].params).toContain('linkedin');
    expect(seen[0].params).toContain('success');
    expect(result.entries[0]).toMatchObject({ connectorId: 'linkedin', action: 'create-post', status: 'success', httpStatus: 201 });
    expect(result.byConnector).toEqual({ linkedin: 1 });
  });

  it('caps the page size however large a caller asks', async () => {
    const seen: unknown[][] = [];
    const pool = { query: async (_sql: string, params: unknown[] = []) => { seen.push(params); return { rows: [] }; } };
    await readConnectorActionAudit(pool, SUB, { limit: 100_000 });
    expect(seen[0][seen[0].length - 1]).toBe(200);
    await readConnectorActionAudit(pool, SUB, { limit: 0 });
    expect(seen[1][seen[1].length - 1]).toBe(50);
  });

  it('reports an empty trail rather than a 500 when the table has never been created', async () => {
    const pool = { query: async () => { throw new Error('relation "connector_action_audit" does not exist'); } };
    await expect(readConnectorActionAudit(pool, SUB)).resolves.toEqual({ entries: [], byConnector: {}, limit: 50 });
  });
});
