#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-06-21 ... | maintainer@emeraldcoastsystemsgroup.com | Vault tool CLI: backs the registered
 *   vault_* tools for the DevOps/Vault app (ADR-040). Talks to HashiCorp Vault's HTTP API using
 *   VAULT_ADDR + VAULT_TOKEN from the environment (server-side, in-container — the token never reaches
 *   a bot prompt). SCOPE: the non-privileged KV v2 path (status / read / write / list at secret/*).
 *   The privileged cloud-credential broker (AWS-STS/kube leases injected into bot runtimes, ephemeral
 *   teardown) is the SEPARATE gated build per ADR-040 and is intentionally NOT here. Mirrors
 *   scripts/oshal-feeds.js / oshal-world.js (a registered cli tool returning JSON on stdout).
 *
 * Verbs (argv[2]) with a JSON input object (argv[3], the tool's {input}):
 *   status               -> Vault health (sealed?, initialized?, version)
 *   read   {path}        -> read a KV v2 secret at secret/<path>
 *   write  {path, data}  -> write a KV v2 secret at secret/<path> (data = object of key/values)
 *   list   {path?}       -> list keys under secret/<path> (default root)
 *   policy {name, paths:[{path,capabilities}]} -> create/update a scoped ACL policy (admin sets scope)
 *   issue  {policy, ttl?} | {engine, role}     -> BROKER: mint a short-TTL scoped credential —
 *                            a child token bound to `policy` (default 15m), OR a dynamic secret from a
 *                            configured secrets engine (engine=aws|database..., role=<vault role>).
 *   lookup {accessor}    -> inspect an issued token's remaining TTL + policies
 *   revoke {accessor}|{leaseId}|{token}        -> revoke the lease/token NOW (provably dead)
 *   setup-db {connectionUrl?, role?, ttl?, maxTtl?}  -> admin: mount the postgresql DATABASE secrets
 *                            engine + a short-TTL role against the app DB, so `issue {engine:"database",
 *                            role}` hands out REAL short-lived Postgres logins (dynamic creds). Idempotent.
 *
 * This IS the credential broker (ADR-040): issue short-TTL scoped creds, use, revoke. The token is read
 * from the controller env (VAULT_TOKEN), never a bot prompt. Single-admin/single-tenant today; the
 * multi-USER ephemeral-runtime isolation (per-session tmpfs, cross-user blast radius) is the remaining
 * piece and only matters when the swarm goes multi-tenant.
 */
'use strict';

const ADDR = (process.env.VAULT_ADDR || 'http://oshal-vault:8200').replace(/\/$/, '');
const TOKEN = (process.env.VAULT_TOKEN || '').trim();
const enc = encodeURIComponent;

function parseInput(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function vault(method, apiPath, body) {
  const res = await fetch(`${ADDR}/v1/${apiPath}`, {
    method,
    headers: { 'X-Vault-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = (json && json.errors && json.errors.join('; ')) || `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json;
}

async function run(verb, input) {
  switch (verb) {
    case 'status': {
      // sys/health is unauthenticated; surface the fields a bot cares about.
      const h = await vault('GET', 'sys/health');
      return { ok: true, sealed: h.sealed, initialized: h.initialized, standby: h.standby, version: h.version, addr: ADDR };
    }
    case 'read': {
      if (!input.path) throw new Error('path required');
      const r = await vault('GET', `secret/data/${encodeURI(input.path)}`);
      return { ok: true, path: input.path, data: r.data ? r.data.data : null, metadata: r.data ? r.data.metadata : null };
    }
    case 'write': {
      if (!input.path) throw new Error('path required');
      if (!input.data || typeof input.data !== 'object') throw new Error('data (object) required');
      const r = await vault('POST', `secret/data/${encodeURI(input.path)}`, { data: input.data });
      return { ok: true, path: input.path, version: r.data ? r.data.version : null };
    }
    case 'list': {
      const p = input.path ? encodeURI(input.path) : '';
      const r = await vault('LIST', `secret/metadata/${p}`);
      return { ok: true, path: input.path || '', keys: (r.data && r.data.keys) || [] };
    }
    case 'policy': {
      // Admin sets the SCOPE: an ACL policy of {path, capabilities}. issue() then binds tokens to it.
      if (!input.name || !Array.isArray(input.paths)) throw new Error('policy requires {name, paths:[{path, capabilities}]}');
      const hcl = input.paths
        .map((p) => `path "${p.path}" { capabilities = [${(p.capabilities || ['read']).map((c) => `"${c}"`).join(', ')}] }`)
        .join('\n');
      await vault('PUT', `sys/policies/acl/${enc(input.name)}`, { policy: hcl });
      return { ok: true, policy: input.name, paths: input.paths.length };
    }
    case 'issue': {
      // BROKER. Dynamic-engine creds (AWS STS, DB user, ...) when {engine, role} given; else a short-TTL
      // child TOKEN scoped to {policy}. Both are leased + revocable; neither persists anywhere.
      if (input.engine && input.role) {
        const r = await vault('GET', `${enc(input.engine)}/creds/${enc(input.role)}`);
        return { ok: true, mode: 'dynamic', engine: input.engine, role: input.role, leaseId: r.lease_id, leaseDuration: r.lease_duration, data: r.data };
      }
      if (input.policy) {
        const policies = Array.isArray(input.policy) ? input.policy : [input.policy];
        const r = await vault('POST', 'auth/token/create', {
          policies, ttl: input.ttl || '15m', no_default_policy: true,
          num_uses: input.numUses || 0, renewable: input.renewable !== false,
        });
        return { ok: true, mode: 'token', token: r.auth.client_token, accessor: r.auth.accessor, ttl: r.auth.lease_duration, policies: r.auth.policies };
      }
      throw new Error('issue requires {policy[, ttl]} (scoped token) or {engine, role} (dynamic secret)');
    }
    case 'lookup': {
      if (!input.accessor) throw new Error('accessor required');
      const r = await vault('POST', 'auth/token/lookup-accessor', { accessor: input.accessor });
      return { ok: true, ttl: r.data.ttl, policies: r.data.policies, expireTime: r.data.expire_time };
    }
    case 'revoke': {
      if (input.accessor) { await vault('POST', 'auth/token/revoke-accessor', { accessor: input.accessor }); return { ok: true, revoked: 'accessor' }; }
      if (input.leaseId) { await vault('PUT', 'sys/leases/revoke', { lease_id: input.leaseId }); return { ok: true, revoked: 'lease' }; }
      if (input.token) { await vault('POST', 'auth/token/revoke', { token: input.token }); return { ok: true, revoked: 'token' }; }
      throw new Error('revoke requires {accessor} or {leaseId} or {token}');
    }
    case 'setup-db': {
      // Admin: mount the postgresql database secrets engine + a short-TTL readonly role against the app
      // DB, so issue({engine:'database', role}) hands out real short-lived Postgres logins. Idempotent.
      const adminUrl = input.connectionUrl || process.env.VAULT_DB_ADMIN_URL || 'postgresql://oshal:oshal@oshal-db:5432/oshal?sslmode=disable';
      const m = adminUrl.match(/^postgresql:\/\/([^:]+):([^@]+)@(.+)$/);
      if (!m) throw new Error('bad connectionUrl (want postgresql://user:pass@host:port/db?sslmode=disable)');
      const [, user, pass, hostpart] = m;
      const role = input.role || 'app-readonly';
      const ttl = input.ttl || '15m';
      const maxTtl = input.maxTtl || '1h';
      // 1) enable the engine (tolerate already-mounted)
      try { await vault('POST', 'sys/mounts/database', { type: 'database' }); }
      catch (e) { if (!/already in use|path is already/i.test(String((e && e.message) || e))) throw e; }
      // 2) configure the connection — templated URL so the admin password isn't stored twice
      await vault('POST', 'database/config/oshal-pg', {
        plugin_name: 'postgresql-database-plugin',
        allowed_roles: [role],
        connection_url: `postgresql://{{username}}:{{password}}@${hostpart}`,
        username: user, password: pass,
      });
      // 3) the short-TTL role: a fresh login per lease, granted read-only, dropped on revoke/expiry
      await vault('POST', `database/roles/${enc(role)}`, {
        db_name: 'oshal-pg',
        // Least-privilege: read-only across public, explicitly NO superuser/createdb/createrole/
        // replication, and a connection cap — defense-in-depth so a leaked short-TTL login can do
        // little even within its window.
        creation_statements: [
          'CREATE ROLE "{{name}}" WITH LOGIN PASSWORD \'{{password}}\' VALID UNTIL \'{{expiration}}\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5;',
          'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{{name}}";',
        ],
        // DROP OWNED BY first — a plain DROP ROLE fails (SQLSTATE 2BP01) because the GRANT SELECT
        // leaves dependent objects; DROP OWNED BY clears them so the role drops cleanly on lease end.
        revocation_statements: [
          'DROP OWNED BY "{{name}}";',
          'DROP ROLE IF EXISTS "{{name}}";',
        ],
        default_ttl: ttl, max_ttl: maxTtl,
      });
      return { ok: true, engine: 'database', mount: 'database', role, ttl, maxTtl, target: hostpart };
    }
    default:
      return { error: `unknown verb "${verb}"`, verbs: ['status', 'read', 'write', 'list', 'policy', 'issue', 'lookup', 'revoke', 'setup-db'] };
  }
}

async function main() {
  if (!TOKEN) { console.error('VAULT_TOKEN not set — cannot authenticate to Vault.'); process.exit(2); }
  const verb = process.argv[2] || 'status';
  const input = parseInput(process.argv[3]);
  const out = await run(verb, input);
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
