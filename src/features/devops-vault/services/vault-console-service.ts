/**
 * VaultConsoleService — the DevOps + Vault console's typed HashiCorp Vault client.
 *
 * The activated (no-longer-facade) DevOps/Vault console (ADR-040) drives real Vault
 * operations from the operator's browser: KV secret management PLUS the credential
 * broker (mint short-TTL scoped creds → use → revoke). This service is the TS sibling
 * of the bot-tool CLI `scripts/oshal-vault.js` — same Vault HTTP surface, but consumed
 * synchronously by the superadmin-gated `/api/devops/*` routes instead of a bot tool.
 * The two are deliberately parallel implementations of a stable API (Vault v1 HTTP):
 * the CLI serves the conversational vault-bot path, this serves the direct console.
 *
 * The Vault token is read from the controller environment (VAULT_TOKEN) and NEVER
 * leaves the server — it is not returned to the browser and not placed in a bot prompt.
 * Scope today: single-admin / single-tenant (matches ADR-040's built tier); the
 * multi-user ephemeral-runtime isolation remains the separate gated build.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — activate the DevOps/Vault console (ADR-040): typed Vault HTTP client mirroring scripts/oshal-vault.js (status/read/write/list/policy/issue/lookup/revoke/setup-db) so the superadmin-gated console executes REAL Vault operations instead of the preview facade.
 *
 * @module features/devops-vault/services/vault-console-service
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'vault-console-service' });

/** A scoped ACL path grant the broker binds tokens to (Vault policy stanza). */
export interface VaultScopePath {
  path: string;
  capabilities?: string[];
}

/** Input to the credential broker: a scoped token ({policy[,ttl]}) OR a dynamic secret ({engine,role}). */
export interface VaultIssueInput {
  policy?: string | string[];
  ttl?: string;
  numUses?: number;
  renewable?: boolean;
  engine?: string;
  role?: string;
}

/** Input to revoke a leased credential — exactly one of accessor / leaseId / token. */
export interface VaultRevokeInput {
  accessor?: string;
  leaseId?: string;
  token?: string;
}

/** Input to mount the database secrets engine + a short-TTL role (setup-db). */
export interface VaultSetupDbInput {
  connectionUrl?: string;
  role?: string;
  ttl?: string;
  maxTtl?: string;
}

/** How the service resolves Vault; defaults come from the controller environment. */
export interface VaultConsoleConfig {
  addr?: string;
  token?: string;
}

/**
 * @description Typed client for the Vault operations the DevOps console exposes. Construct
 * once per request (cheap); reads VAULT_ADDR / VAULT_TOKEN from the environment unless
 * overridden. Every method returns plain JSON-serializable data for the route to relay.
 */
export class VaultConsoleService {
  private readonly addr: string;
  private readonly token: string;

  constructor(config: VaultConsoleConfig = {}) {
    this.addr = (config.addr ?? process.env.VAULT_ADDR ?? 'http://oshal-vault:8200').replace(/\/$/, '');
    this.token = (config.token ?? process.env.VAULT_TOKEN ?? '').trim();
  }

  /** True when a Vault token is configured — the route uses this to 503 cleanly when unset. */
  isConfigured(): boolean {
    return this.token.length > 0;
  }

  /** One authenticated Vault HTTP call; throws a sanitized Error (never revealing the token) on non-2xx. */
  private async vault(method: string, apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.addr}/v1/${apiPath}`, {
      method,
      headers: { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const errors = (json as { errors?: string[] }).errors;
      throw new Error(Array.isArray(errors) && errors.length ? errors.join('; ') : `Vault HTTP ${res.status}`);
    }
    return json;
  }

  /**
   * Vault connection health as a traffic light — the console's at-a-glance creds indicator:
   *   green  = reachable, unsealed, AND our token is valid (fully working)
   *   yellow = the Vault server can't be reached (network/DNS/down) — transient/config
   *   red    = reachable but unusable: sealed, or our token is denied/expired
   * Uses raw fetch (not the throwing helper) so sealed (503) / denied (403) are classified,
   * not swallowed as generic errors.
   */
  async status(): Promise<Record<string, unknown>> {
    let health: { sealed?: boolean; initialized?: boolean; standby?: boolean; version?: string };
    try {
      const r = await fetch(`${this.addr}/v1/sys/health?sealedcode=200&standbycode=200&uninitcode=200`);
      health = (await r.json().catch(() => ({}))) as typeof health;
    } catch (e) {
      return { ok: false, light: 'yellow', reason: 'unreachable', error: String((e as Error).message), addr: this.addr };
    }
    if (health.sealed) return { ok: false, light: 'red', reason: 'sealed', sealed: true, version: health.version, addr: this.addr };
    // Reachable + unsealed — is OUR token accepted? lookup-self distinguishes 'working' from 'denied'.
    const tok = await fetch(`${this.addr}/v1/auth/token/lookup-self`, { headers: { 'X-Vault-Token': this.token } });
    if (tok.status === 403 || tok.status === 401) return { ok: false, light: 'red', reason: 'denied', version: health.version, addr: this.addr };
    if (!tok.ok) return { ok: false, light: 'yellow', reason: 'unreachable', version: health.version, addr: this.addr };
    return { ok: true, light: 'green', reason: 'working', sealed: false, initialized: health.initialized, standby: health.standby, version: health.version, addr: this.addr };
  }

  /** Read a KV v2 secret at secret/<path>. */
  async read(path: string): Promise<Record<string, unknown>> {
    if (!path) throw new Error('path required');
    const r = await this.vault('GET', `secret/data/${encodeURI(path)}`);
    const data = r.data as { data?: unknown; metadata?: unknown } | undefined;
    return { ok: true, path, data: data?.data ?? null, metadata: data?.metadata ?? null };
  }

  /** Write a KV v2 secret at secret/<path> (data = flat key/value object). */
  async write(path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!path) throw new Error('path required');
    if (!data || typeof data !== 'object') throw new Error('data (object) required');
    const r = await this.vault('POST', `secret/data/${encodeURI(path)}`, { data });
    return { ok: true, path, version: (r.data as { version?: number } | undefined)?.version ?? null };
  }

  /** List KV keys under secret/<path> (default root). */
  async list(path?: string): Promise<Record<string, unknown>> {
    const r = await this.vault('LIST', `secret/metadata/${path ? encodeURI(path) : ''}`);
    return { ok: true, path: path ?? '', keys: (r.data as { keys?: string[] } | undefined)?.keys ?? [] };
  }

  /**
   * Delete a KV v2 secret entirely — removes the metadata and ALL versions at secret/<path>
   * (not the soft "delete latest version"). Deleting a non-existent path is a no-op success,
   * so the console's delete affordance is idempotent. A trailing '/' path is a folder prefix
   * with no secret of its own and is rejected rather than silently deleting the tree.
   */
  async remove(path: string): Promise<Record<string, unknown>> {
    if (!path || path.endsWith('/')) throw new Error('a secret path (not a folder prefix) is required');
    await this.vault('DELETE', `secret/metadata/${encodeURI(path)}`);
    return { ok: true, path, removed: true };
  }

  /** Admin sets the SCOPE: an ACL policy of {path, capabilities} the broker binds tokens to. */
  async policy(name: string, paths: VaultScopePath[]): Promise<Record<string, unknown>> {
    if (!name || !Array.isArray(paths) || !paths.length) throw new Error('policy requires {name, paths:[{path, capabilities}]}');
    const hcl = paths
      .map((p) => `path "${p.path}" { capabilities = [${(p.capabilities ?? ['read']).map((c) => `"${c}"`).join(', ')}] }`)
      .join('\n');
    await this.vault('PUT', `sys/policies/acl/${encodeURIComponent(name)}`, { policy: hcl });
    return { ok: true, policy: name, paths: paths.length };
  }

  /** BROKER — mint a short-TTL credential: dynamic secret ({engine,role}) or scoped child token ({policy[,ttl]}). */
  async issue(input: VaultIssueInput): Promise<Record<string, unknown>> {
    if (input.engine && input.role) {
      const r = await this.vault('GET', `${encodeURIComponent(input.engine)}/creds/${encodeURIComponent(input.role)}`);
      return { ok: true, mode: 'dynamic', engine: input.engine, role: input.role, leaseId: r.lease_id, leaseDuration: r.lease_duration, data: r.data };
    }
    if (input.policy) {
      const policies = Array.isArray(input.policy) ? input.policy : [input.policy];
      const r = await this.vault('POST', 'auth/token/create', {
        policies, ttl: input.ttl || '15m', no_default_policy: true,
        num_uses: input.numUses ?? 0, renewable: input.renewable !== false,
      });
      const auth = r.auth as { client_token?: string; accessor?: string; lease_duration?: number; policies?: string[] };
      return { ok: true, mode: 'token', token: auth?.client_token, accessor: auth?.accessor, ttl: auth?.lease_duration, policies: auth?.policies };
    }
    throw new Error('issue requires {policy[, ttl]} (scoped token) or {engine, role} (dynamic secret)');
  }

  /** Inspect an issued token's remaining TTL + policies by accessor. */
  async lookup(accessor: string): Promise<Record<string, unknown>> {
    if (!accessor) throw new Error('accessor required');
    const r = await this.vault('POST', 'auth/token/lookup-accessor', { accessor });
    const d = r.data as { ttl?: number; policies?: string[]; expire_time?: string };
    return { ok: true, ttl: d?.ttl, policies: d?.policies, expireTime: d?.expire_time };
  }

  /** Revoke an issued credential NOW (provably dead) by accessor / leaseId / token. */
  async revoke(input: VaultRevokeInput): Promise<Record<string, unknown>> {
    if (input.accessor) { await this.vault('POST', 'auth/token/revoke-accessor', { accessor: input.accessor }); return { ok: true, revoked: 'accessor' }; }
    if (input.leaseId) { await this.vault('PUT', 'sys/leases/revoke', { lease_id: input.leaseId }); return { ok: true, revoked: 'lease' }; }
    if (input.token) { await this.vault('POST', 'auth/token/revoke', { token: input.token }); return { ok: true, revoked: 'token' }; }
    throw new Error('revoke requires {accessor} or {leaseId} or {token}');
  }

  /**
   * Admin: mount the postgresql database secrets engine + a short-TTL read-only role against the
   * app DB, so issue({engine:'database', role}) hands out REAL short-lived Postgres logins. Idempotent.
   */
  async setupDb(input: VaultSetupDbInput): Promise<Record<string, unknown>> {
    const adminUrl = input.connectionUrl || process.env.VAULT_DB_ADMIN_URL || 'postgresql://oshal:oshal@oshal-db:5432/oshal?sslmode=disable';
    const m = adminUrl.match(/^postgresql:\/\/([^:]+):([^@]+)@(.+)$/);
    if (!m) throw new Error('bad connectionUrl (want postgresql://user:pass@host:port/db?sslmode=disable)');
    const [, user, pass, hostpart] = m;
    const role = input.role || 'app-readonly';
    const ttl = input.ttl || '15m';
    const maxTtl = input.maxTtl || '1h';
    try { await this.vault('POST', 'sys/mounts/database', { type: 'database' }); }
    catch (e) { if (!/already in use|path is already/i.test(String((e as Error).message))) throw e; }
    await this.vault('POST', 'database/config/oshal-pg', {
      plugin_name: 'postgresql-database-plugin',
      allowed_roles: [role],
      connection_url: `postgresql://{{username}}:{{password}}@${hostpart}`,
      username: user, password: pass,
    });
    await this.vault('POST', `database/roles/${encodeURIComponent(role)}`, {
      db_name: 'oshal-pg',
      creation_statements: [
        'CREATE ROLE "{{name}}" WITH LOGIN PASSWORD \'{{password}}\' VALID UNTIL \'{{expiration}}\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 5;',
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{{name}}";',
      ],
      revocation_statements: ['DROP OWNED BY "{{name}}";', 'DROP ROLE IF EXISTS "{{name}}";'],
      default_ttl: ttl, max_ttl: maxTtl,
    });
    logger.info({ role, ttl, maxTtl, target: hostpart }, 'mounted vault database engine + role');
    return { ok: true, engine: 'database', mount: 'database', role, ttl, maxTtl, target: hostpart };
  }
}
