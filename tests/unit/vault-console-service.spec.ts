/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — VaultConsoleService offline contract (ADR-040 activation): a fake fetch proves each verb hits the right Vault HTTP path/method and parses the response, the broker returns the token+accessor, a Vault error surfaces its `errors[]`, and an unset token is reported (never dispatched).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultConsoleService } from '../../src/features/devops-vault';

interface Recorded { url: string; method: string; token?: string; body?: unknown }

/** Install a fake global fetch that records the call and returns a canned Vault body. */
function fakeVault(responder: (rec: Recorded) => { status?: number; json: unknown }): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const opts = init || {};
    const headers = (opts.headers || {}) as Record<string, string>;
    const rec: Recorded = {
      url, method: opts.method || 'GET', token: headers['X-Vault-Token'],
      body: opts.body ? JSON.parse(String(opts.body)) : undefined,
    };
    calls.push(rec);
    const { status = 200, json } = responder(rec);
    return {
      ok: status >= 200 && status < 300, status,
      text: async () => JSON.stringify(json), json: async () => json,
    } as Response;
  });
  return calls;
}

const svc = () => new VaultConsoleService({ addr: 'http://vault.test:8200', token: 'root-test-token' });

/** Install a fake Vault and immediately run status() (the multi-probe path). */
async function fakeAndStatus(responder: (rec: Recorded) => { status?: number; json: unknown }): Promise<Record<string, unknown>> {
  fakeVault(responder);
  return svc().status();
}

afterEach(() => vi.unstubAllGlobals());

describe('VaultConsoleService', () => {
  it('status → GREEN when reachable, unsealed, and the token is accepted', async () => {
    const calls = fakeVault((rec) => rec.url.includes('sys/health')
      ? { json: { sealed: false, initialized: true, standby: false, version: '1.18.5' } }
      : { json: { data: { policies: ['root'] } } }); // lookup-self OK
    const out = await svc().status();
    expect(out).toMatchObject({ ok: true, light: 'green', reason: 'working', version: '1.18.5', addr: 'http://vault.test:8200' });
    expect(calls[0].url).toContain('/v1/sys/health');
    expect(calls[1].url).toContain('/v1/auth/token/lookup-self');
  });

  it('status → RED (denied) when Vault is reachable but the token is rejected', async () => {
    const out = await fakeAndStatus((rec) => rec.url.includes('sys/health')
      ? { json: { sealed: false, version: '1.18.5' } }
      : { status: 403, json: { errors: ['permission denied'] } });
    expect(out).toMatchObject({ ok: false, light: 'red', reason: 'denied' });
  });

  it('status → YELLOW (unreachable) when the health probe throws', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const out = await svc().status();
    expect(out).toMatchObject({ ok: false, light: 'yellow', reason: 'unreachable' });
  });

  it('status → RED (sealed) when Vault reports sealed', async () => {
    const out = await fakeAndStatus(() => ({ json: { sealed: true, version: '1.18.5' } }));
    expect(out).toMatchObject({ ok: false, light: 'red', reason: 'sealed' });
  });

  it('read unwraps KV v2 data + metadata', async () => {
    fakeVault(() => ({ json: { data: { data: { api_key: 'xyz' }, metadata: { version: 3 } } } }));
    const out = await svc().read('aws/prod');
    expect(out).toMatchObject({ ok: true, path: 'aws/prod', data: { api_key: 'xyz' }, metadata: { version: 3 } });
  });

  it('write posts {data} to secret/data/<path> and returns the new version', async () => {
    const calls = fakeVault(() => ({ json: { data: { version: 7 } } }));
    const out = await svc().write('aws/prod', { api_key: 'new' });
    expect(out).toMatchObject({ ok: true, version: 7 });
    expect(calls[0]).toMatchObject({ url: 'http://vault.test:8200/v1/secret/data/aws/prod', method: 'POST', body: { data: { api_key: 'new' } } });
  });

  it('list uses the LIST method on secret/metadata and returns keys', async () => {
    const calls = fakeVault(() => ({ json: { data: { keys: ['prod', 'staging'] } } }));
    const out = await svc().list('aws');
    expect(out).toMatchObject({ ok: true, keys: ['prod', 'staging'] });
    expect(calls[0]).toMatchObject({ method: 'LIST', url: 'http://vault.test:8200/v1/secret/metadata/aws' });
  });

  it('issue (token mode) binds the policy and returns the client token + accessor', async () => {
    const calls = fakeVault(() => ({ json: { auth: { client_token: 'hvs.child', accessor: 'acc-123', lease_duration: 900, policies: ['deploy'] } } }));
    const out = await svc().issue({ policy: 'deploy', ttl: '15m' });
    expect(out).toMatchObject({ ok: true, mode: 'token', token: 'hvs.child', accessor: 'acc-123', ttl: 900 });
    expect(calls[0]).toMatchObject({ url: 'http://vault.test:8200/v1/auth/token/create', method: 'POST' });
    expect(calls[0].body).toMatchObject({ policies: ['deploy'], ttl: '15m', no_default_policy: true });
  });

  it('issue (dynamic mode) reads <engine>/creds/<role> and returns the lease', async () => {
    const calls = fakeVault(() => ({ json: { lease_id: 'database/creds/app/abc', lease_duration: 900, data: { username: 'v-token-app', password: 'p' } } }));
    const out = await svc().issue({ engine: 'database', role: 'app-readonly' });
    expect(out).toMatchObject({ ok: true, mode: 'dynamic', leaseId: 'database/creds/app/abc' });
    expect(calls[0]).toMatchObject({ url: 'http://vault.test:8200/v1/database/creds/app-readonly', method: 'GET' });
  });

  it('remove deletes the metadata (all versions) at secret/<path>', async () => {
    const calls = fakeVault(() => ({ status: 204, json: {} }));
    const out = await svc().remove('verify/gone');
    expect(out).toMatchObject({ ok: true, path: 'verify/gone', removed: true });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'http://vault.test:8200/v1/secret/metadata/verify/gone' });
  });

  it('remove rejects a folder prefix (trailing slash) rather than deleting a tree', async () => {
    const calls = fakeVault(() => ({ json: {} }));
    await expect(svc().remove('verify/')).rejects.toThrow(/secret path/);
    expect(calls.length).toBe(0); // never dispatched
  });

  it('revoke by accessor calls revoke-accessor', async () => {
    const calls = fakeVault(() => ({ json: {} }));
    const out = await svc().revoke({ accessor: 'acc-123' });
    expect(out).toMatchObject({ ok: true, revoked: 'accessor' });
    expect(calls[0]).toMatchObject({ url: 'http://vault.test:8200/v1/auth/token/revoke-accessor', body: { accessor: 'acc-123' } });
  });

  it('a Vault error surfaces its errors[] as the thrown message', async () => {
    fakeVault(() => ({ status: 403, json: { errors: ['permission denied'] } }));
    await expect(svc().read('secret/x')).rejects.toThrow('permission denied');
  });

  it('reports an unset token instead of dispatching', () => {
    expect(new VaultConsoleService({ addr: 'http://vault.test:8200', token: '' }).isConfigured()).toBe(false);
    expect(svc().isConfigured()).toBe(true);
  });
});
