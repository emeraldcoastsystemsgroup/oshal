/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the marketing-engine connector rails (ADR-133): the three specs (google-search-console, resend, mastodon) must load through the REAL loader; gsc must ride the caller's ONE google connection (credProvider); the resend send-email and mastodon create-status actions must stay high-risk + approval-gated; bluesky/resend must exist in PROVIDERS as token-paste entries; and the write executor must 428-refuse an unconfirmed high action WITHOUT resolving credentials or touching the network (fetch spy + stub audit pool — zero network in this file).
 */

import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import { connectorActionRequiresApproval, validateSpecActions } from '../../src/app/connectors/runtime/action-params';
import { runConnectorAction, type ConnectorActionAuditPool } from '../../src/app/connectors/runtime/action-executor';
import { loadConnectorSpec } from '../../src/app/connectors/runtime/spec';
import { CONNECTOR_CATEGORY, PROVIDERS } from '../../src/app/routes/connector-provider-registry';

const SPEC_DIR = path.resolve(__dirname, '../../swarm-apps/connectors');
const gsc = loadConnectorSpec(path.join(SPEC_DIR, 'google-search-console.yaml'));
const resend = loadConnectorSpec(path.join(SPEC_DIR, 'resend.yaml'));
const mastodon = loadConnectorSpec(path.join(SPEC_DIR, 'mastodon.yaml'));

describe('marketing connector specs load via the real loader', () => {
  it('google-search-console parses and rides the google broker key', () => {
    expect(gsc.provider).toBe('google-search-console');
    expect(gsc.credProvider).toBe('google');
    expect(gsc.auth.type).toBe('oauth2');
    expect(gsc.baseUrl).toBe('https://www.googleapis.com/webmasters/v3');
    const names = gsc.resources.map((r) => r.name);
    expect(names).toContain('sites');
    expect(names).toContain('searchanalytics');
    const sa = gsc.resources.find((r) => r.name === 'searchanalytics')!;
    expect(sa.method).toBe('POST');
    expect(sa.path).toBe('/sites/{siteUrl}/searchAnalytics/query');
    // POST-verb READ: declared read so the spec-routes confirm gate never blocks the query.
    expect(sa.safety?.action).toBe('read');
  });

  it('resend parses with the read tier and the send-email action', () => {
    expect(resend.provider).toBe('resend');
    expect(resend.baseUrl).toBe('https://api.resend.com');
    expect(resend.resources.map((r) => r.name)).toEqual(expect.arrayContaining(['domains', 'audiences']));
    expect((resend.actions ?? []).map((a) => a.name)).toContain('send-email');
  });

  it('mastodon parses at 1.1.0 with the create-status action appended', () => {
    expect(mastodon.provider).toBe('mastodon');
    expect(mastodon.version).toBe('1.1.0');
    expect((mastodon.actions ?? []).map((a) => a.name)).toContain('create-status');
  });
});

describe('write actions validate and stay high-risk + approval-gated', () => {
  it('resend send-email survives validateSpecActions and requires approval', () => {
    const actions = validateSpecActions(resend.provider, resend.actions);
    const send = actions.find((a) => a.name === 'send-email')!;
    expect(send.riskLevel).toBe('high');
    expect(send.approvalRequired).toBe(true);
    expect(connectorActionRequiresApproval(send)).toBe(true);
    const schema = send.paramsSchema as { required?: string[]; additionalProperties?: boolean };
    expect(schema.required).toEqual(expect.arrayContaining(['from', 'to', 'subject']));
    expect(schema.additionalProperties).toBe(false);
  });

  it('mastodon create-status survives validateSpecActions and requires approval', () => {
    const actions = validateSpecActions(mastodon.provider, mastodon.actions);
    const post = actions.find((a) => a.name === 'create-status')!;
    expect(post.riskLevel).toBe('high');
    expect(post.approvalRequired).toBe(true);
    expect(connectorActionRequiresApproval(post)).toBe(true);
    const status = (post.paramsSchema as { properties?: Record<string, { minLength?: number; maxLength?: number }> }).properties?.status;
    expect(status?.minLength).toBe(1);
    expect(status?.maxLength).toBe(500);
  });
});

describe('token-paste registry entries', () => {
  it('bluesky exists as a token connector with the app-password help link, categorized social', () => {
    expect(PROVIDERS.bluesky).toBeDefined();
    expect(PROVIDERS.bluesky.auth).toBe('token');
    expect(PROVIDERS.bluesky.flavor).toBe('generic');
    expect(PROVIDERS.bluesky.tokenHelpUrl).toBe('https://bsky.app/settings/app-passwords');
    expect(CONNECTOR_CATEGORY.bluesky).toBe('social');
  });

  it('resend exists as a token connector with the api-keys help link, categorized email', () => {
    expect(PROVIDERS.resend).toBeDefined();
    expect(PROVIDERS.resend.auth).toBe('token');
    expect(PROVIDERS.resend.flavor).toBe('generic');
    expect(PROVIDERS.resend.tokenHelpUrl).toBe('https://resend.com/api-keys');
    expect(CONNECTOR_CATEGORY.resend).toBe('email');
  });
});

describe('the confirm gate refuses an unconfirmed high action (no creds, no network)', () => {
  it('runConnectorAction 428s send-email without confirm:true and never touches broker or provider', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool: ConnectorActionAuditPool = {
      query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return {}; },
    };
    const resolveCreds = vi.fn(async () => ({ token: async () => 'never-used' }));
    const fetchSpy = vi.fn(async () => { throw new Error('network must not be touched'); });

    const result = await runConnectorAction({
      pool,
      spec: resend,
      resolveCreds,
      userSub: 'test-user',
      actionName: 'send-email',
      params: { from: 'oshal <news@example.com>', to: 'someone@example.com', subject: 'hello', text: 'body' },
      requestBody: {}, // no confirm:true
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.status).toBe(428);
    expect(result.body.ok).toBe(false);
    expect((result.body as Record<string, unknown>).error).toBe('confirmation_required');
    expect((result.body as Record<string, unknown>).guard).toBe('connector-write');
    // Fail-closed order: the gate fires BEFORE credential resolution and before any HTTP.
    expect(resolveCreds).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The refusal is audited (confirmation_required row against the stub pool).
    const insert = queries.find((q) => q.sql.includes('INSERT INTO connector_action_audit'));
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual(expect.arrayContaining(['test-user', 'resend', 'send-email', 'confirmation_required']));
  });

  it('confirm:true alone does not unlock a caller with no connection (audited not_connected, still no network)', async () => {
    const pool: ConnectorActionAuditPool = { query: async () => ({}) };
    const fetchSpy = vi.fn(async () => { throw new Error('network must not be touched'); });
    const result = await runConnectorAction({
      pool,
      spec: mastodon,
      resolveCreds: async () => null, // broker: no stored connection
      userSub: 'test-user',
      actionName: 'create-status',
      params: { status: 'hello world' },
      requestBody: { confirm: true },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(result.status).toBe(401);
    expect((result.body as Record<string, unknown>).code).toBe('not_connected');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
