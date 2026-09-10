/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-147: registries become ROWS. The store was one module constant read from OSHAL_STORE_REPO with a single module-level catalog cache, so a swarm could read exactly one git location and GitHub was assumed in four places. This table holds N registries, each with its own host kind, ref, trust record and access key. The built-in row is seeded FROM the existing env vars so an established deployment adopts this with zero configuration change and its store keeps working untouched. Keys are stored Vault-first (the operator asked for vault) with an encrypted Postgres column as the durable fallback — Vault runs in dev mode here (in-memory, ADR-040), so a key written ONLY to Vault would evaporate on restart; secret_backend records which one actually holds it so the UI can say where the key lives instead of leaving a vanished key mysterious.
 */

import type { Pool } from 'pg';
import crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { encryptToken, decryptToken } from '@/app/routes/connector-token-crypto';
import { VaultConsoleService } from '@/features/devops-vault';
import {
  inferHostKind, normalizeRepoUrl, fetchFenceProblem,
  type RegistryHostKind, type RegistrySource,
} from './registry-host-adapters';

const logger = createChildLogger({ module: 'app-registry-store' });

/** Slug contract — the disambiguator in the UI and in `<registry>/<package>` identity. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Where a registry's access key actually lives. */
export type SecretBackend = 'none' | 'vault' | 'db';

/** Vault KV path for a registry key. Slug-validated before it ever reaches this. */
function vaultPath(slug: string): string {
  return `oshal/app-registries/${slug}`;
}

/** One registry, as the API returns it. NEVER carries the key — only whether one exists. */
export interface AppRegistry {
  id: string;
  slug: string;
  displayName: string;
  url: string;
  ref: string;
  hostKind: RegistryHostKind;
  builtin: boolean;
  enabled: boolean;
  trustState: 'trusted' | 'revoked';
  allowUnsigned: boolean;
  allowPrivateHost: boolean;
  hasKey: boolean;
  secretBackend: SecretBackend;
  trustedBySub: string | null;
  trustedAt: string | null;
  trustNote: string | null;
  lastFetchAt: string | null;
  lastFetchOk: boolean | null;
  lastFetchError: string | null;
  packageCount: number | null;
}

/** Raised for an expected, caller-visible failure so routes can map it to a status. */
export class AppRegistryError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AppRegistryError';
  }
}

/**
 * @description Creates the registry table if absent, at the same lazy-DDL chokepoint the other
 * runtime stores use. Not owner-RLS'd: registries are swarm-wide infrastructure, every read is
 * already fenced by requiresOperator in the route layer, and the aggregate catalog must read
 * every row under the system identity.
 * @param pool - Postgres pool.
 * @returns Resolves when the table exists.
 */
export async function ensureAppRegistrySchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'app registry store',
    statements: [
      `CREATE TABLE IF NOT EXISTS app_registries (
        id                 TEXT PRIMARY KEY,
        slug               TEXT UNIQUE NOT NULL,
        display_name       TEXT NOT NULL,
        url                TEXT NOT NULL,
        ref                TEXT NOT NULL DEFAULT 'main',
        host_kind          TEXT NOT NULL DEFAULT 'generic-git',
        builtin            BOOLEAN NOT NULL DEFAULT FALSE,
        enabled            BOOLEAN NOT NULL DEFAULT TRUE,
        trust_state        TEXT NOT NULL DEFAULT 'trusted',
        allow_unsigned     BOOLEAN NOT NULL DEFAULT FALSE,
        allow_private_host BOOLEAN NOT NULL DEFAULT FALSE,
        secret_backend     TEXT NOT NULL DEFAULT 'none',
        token_ciphertext   TEXT,
        trusted_by_sub     TEXT,
        trusted_at         TIMESTAMPTZ,
        trust_note         TEXT,
        last_fetch_at      TIMESTAMPTZ,
        last_fetch_ok      BOOLEAN,
        last_fetch_error   TEXT,
        package_count      INTEGER,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS app_registries_url_ref ON app_registries (url, ref)`,
    ],
    requirements: [{
      table: 'app_registries',
      columns: ['id', 'slug', 'url', 'ref', 'host_kind', 'builtin', 'enabled', 'trust_state', 'secret_backend'],
    }],
  });
}

/** Row → public shape. The ONE projection, so token_ciphertext can never leak by accident. */
function toRegistry(r: Record<string, unknown>): AppRegistry {
  const backend = String(r.secret_backend ?? 'none') as SecretBackend;
  return {
    id: String(r.id),
    slug: String(r.slug),
    displayName: String(r.display_name),
    url: String(r.url),
    ref: String(r.ref),
    hostKind: String(r.host_kind) as RegistryHostKind,
    builtin: Boolean(r.builtin),
    enabled: Boolean(r.enabled),
    trustState: String(r.trust_state) as 'trusted' | 'revoked',
    allowUnsigned: Boolean(r.allow_unsigned),
    allowPrivateHost: Boolean(r.allow_private_host),
    hasKey: backend !== 'none',
    secretBackend: backend,
    trustedBySub: (r.trusted_by_sub as string | null) ?? null,
    trustedAt: r.trusted_at instanceof Date ? r.trusted_at.toISOString() : (r.trusted_at as string | null) ?? null,
    trustNote: (r.trust_note as string | null) ?? null,
    lastFetchAt: r.last_fetch_at instanceof Date ? r.last_fetch_at.toISOString() : (r.last_fetch_at as string | null) ?? null,
    lastFetchOk: r.last_fetch_ok === null || r.last_fetch_ok === undefined ? null : Boolean(r.last_fetch_ok),
    lastFetchError: (r.last_fetch_error as string | null) ?? null,
    packageCount: r.package_count === null || r.package_count === undefined ? null : Number(r.package_count),
  };
}

const COLS = `id, slug, display_name, url, ref, host_kind, builtin, enabled, trust_state,
  allow_unsigned, allow_private_host, secret_backend, trusted_by_sub, trusted_at, trust_note,
  last_fetch_at, last_fetch_ok, last_fetch_error, package_count`;

/**
 * @description Lists every registry, built-in first then by creation order.
 * @param pool - Postgres pool.
 * @returns All registries, never carrying a key.
 */
export async function listRegistries(pool: Pool): Promise<AppRegistry[]> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT ${COLS} FROM app_registries ORDER BY builtin DESC, created_at ASC`,
  ));
  return rows.map(toRegistry);
}

/**
 * @description Reads one registry by slug.
 * @param pool - Postgres pool.
 * @param slug - the registry slug.
 * @returns The registry, or null.
 */
export async function getRegistry(pool: Pool, slug: string): Promise<AppRegistry | null> {
  const { rows } = await runWithSystemIdentity(() => pool.query(
    `SELECT ${COLS} FROM app_registries WHERE slug = $1`, [slug],
  ));
  return rows.length ? toRegistry(rows[0]) : null;
}

/**
 * @description Stores a registry's access key, Vault first with the encrypted column as the
 * durable fallback.
 *
 * Vault is preferred because the operator asked for it and because a real Vault gives lease and
 * audit semantics a column cannot. It is NOT trusted blindly: this deployment runs Vault in dev
 * mode (in-memory), so a write that succeeded and then vanished on restart would look like data
 * loss with no explanation. On any Vault failure the key is encrypted into Postgres instead
 * (shared-HKDF envelope — swarm-wide, not per-user, which is what a registry credential is), and
 * the backend actually used is recorded so the UI can state where the key lives.
 *
 * @param pool - Postgres pool.
 * @param slug - the registry slug (already validated).
 * @param token - the plaintext key; '' clears it.
 * @returns The backend that accepted the key.
 */
async function storeRegistryKey(pool: Pool, slug: string, token: string): Promise<SecretBackend> {
  if (!token) {
    await runWithSystemIdentity(() => pool.query(
      `UPDATE app_registries SET secret_backend = 'none', token_ciphertext = NULL WHERE slug = $1`, [slug],
    ));
    return 'none';
  }
  const vault = new VaultConsoleService();
  if (vault.isConfigured()) {
    try {
      await vault.write(vaultPath(slug), { token });
      await runWithSystemIdentity(() => pool.query(
        `UPDATE app_registries SET secret_backend = 'vault', token_ciphertext = NULL WHERE slug = $1`, [slug],
      ));
      logger.info({ slug }, 'registry key stored in vault');
      return 'vault';
    } catch (err) {
      logger.warn({ err, slug }, 'vault write failed — falling back to the encrypted column');
    }
  }
  const blob = await encryptToken(pool, undefined, token);
  await runWithSystemIdentity(() => pool.query(
    `UPDATE app_registries SET secret_backend = 'db', token_ciphertext = $2 WHERE slug = $1`, [slug, blob],
  ));
  logger.info({ slug }, 'registry key stored encrypted in the database');
  return 'db';
}

/**
 * @description Resolves a registry's plaintext key for an outbound call. Returns '' for a public
 * registry, and '' (never a throw) when a key was recorded but cannot be read back — a Vault that
 * restarted in dev mode is the expected case, and it must degrade to "unauthorized read" with an
 * honest reason rather than crashing the catalog page.
 * @param pool - Postgres pool.
 * @param registry - the registry row.
 * @returns The plaintext key, or ''.
 */
export async function resolveRegistryKey(pool: Pool, registry: AppRegistry): Promise<string> {
  if (registry.secretBackend === 'none') return '';
  try {
    if (registry.secretBackend === 'vault') {
      const result = await new VaultConsoleService().read(vaultPath(registry.slug));
      const data = result.data as { token?: unknown } | null;
      return typeof data?.token === 'string' ? data.token : '';
    }
    const { rows } = await runWithSystemIdentity(() => pool.query(
      'SELECT token_ciphertext FROM app_registries WHERE slug = $1', [registry.slug],
    ));
    const blob = rows[0]?.token_ciphertext as string | null;
    return blob ? await decryptToken(pool, undefined, blob) : '';
  } catch (err) {
    logger.error({ err, slug: registry.slug, backend: registry.secretBackend }, 'registry key could not be resolved');
    return '';
  }
}

/**
 * @description Turns a registry row plus its resolved key into the shape the host adapters take.
 * @param pool - Postgres pool.
 * @param registry - the registry row.
 * @returns The adapter source, key included.
 */
export async function toRegistrySource(pool: Pool, registry: AppRegistry): Promise<RegistrySource> {
  return {
    slug: registry.slug,
    url: registry.url,
    ref: registry.ref,
    hostKind: registry.hostKind,
    token: await resolveRegistryKey(pool, registry),
    allowPrivateHost: registry.allowPrivateHost,
  };
}

/** Validates the caller-supplied parts of a registry before anything is written. */
function validateInput(input: { slug: string; url: string; allowPrivateHost?: boolean }): void {
  if (!SLUG_RE.test(input.slug)) {
    throw new AppRegistryError(400, 'slug must be 2–32 characters: lowercase letters, digits and dashes');
  }
  const fence = fetchFenceProblem(normalizeRepoUrl(input.url), input.allowPrivateHost === true);
  if (fence) throw new AppRegistryError(400, fence);
}

/**
 * @description Adds a registry — the TRUST ACT. The caller is declaring it will accept code from
 * this git location, so this is deliberately heavier than saving a text field: the route probes
 * the catalog before calling this, and who trusted it and when are recorded permanently.
 * @param pool - Postgres pool.
 * @param input - the registry definition, the trusting caller, and an optional access key.
 * @returns The created registry.
 * @throws AppRegistryError 400 on invalid input, 409 on a duplicate slug or url+ref.
 */
export async function addRegistry(
  pool: Pool,
  input: {
    slug: string; displayName: string; url: string; ref?: string; hostKind?: RegistryHostKind;
    allowUnsigned?: boolean; allowPrivateHost?: boolean; token?: string;
    trustedBySub: string | null; trustNote?: string | null;
  },
): Promise<AppRegistry> {
  validateInput(input);
  const url = normalizeRepoUrl(input.url);
  const ref = (input.ref || 'main').trim();
  const hostKind = input.hostKind ?? inferHostKind(url);
  const id = crypto.randomUUID();
  try {
    await runWithSystemIdentity(() => pool.query(
      `INSERT INTO app_registries
         (id, slug, display_name, url, ref, host_kind, builtin, enabled, trust_state,
          allow_unsigned, allow_private_host, trusted_by_sub, trusted_at, trust_note)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,TRUE,'trusted',$7,$8,$9,NOW(),$10)`,
      [id, input.slug, input.displayName || input.slug, url, ref, hostKind,
        input.allowUnsigned === true, input.allowPrivateHost === true,
        input.trustedBySub, input.trustNote ?? null],
    ));
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppRegistryError(409, 'a registry with that name, or that repository and ref, already exists');
    }
    throw err;
  }
  if (input.token) await storeRegistryKey(pool, input.slug, input.token);
  logger.warn({ slug: input.slug, url, hostKind, by: input.trustedBySub }, 'APP REGISTRY TRUSTED');
  const created = await getRegistry(pool, input.slug);
  if (!created) throw new AppRegistryError(500, 'registry was written but could not be read back');
  return created;
}

/**
 * @description Updates the mutable parts of a registry. The built-in row accepts every field
 * EXCEPT deletion — an operator must be able to point the default store somewhere else, add a
 * key to it, or turn it off, without being able to lose it.
 * @param pool - Postgres pool.
 * @param slug - the registry to update.
 * @param patch - the fields to change; `token` of '' clears the key, undefined leaves it alone.
 * @returns The updated registry.
 * @throws AppRegistryError 404 when absent, 400 on invalid input.
 */
export async function updateRegistry(
  pool: Pool,
  slug: string,
  patch: {
    displayName?: string; url?: string; ref?: string; hostKind?: RegistryHostKind;
    enabled?: boolean; trustState?: 'trusted' | 'revoked'; allowUnsigned?: boolean;
    allowPrivateHost?: boolean; token?: string;
  },
): Promise<AppRegistry> {
  const current = await getRegistry(pool, slug);
  if (!current) throw new AppRegistryError(404, `no registry named "${slug}"`);

  const url = patch.url === undefined ? current.url : normalizeRepoUrl(patch.url);
  const allowPrivateHost = patch.allowPrivateHost ?? current.allowPrivateHost;
  validateInput({ slug, url, allowPrivateHost });

  await runWithSystemIdentity(() => pool.query(
    `UPDATE app_registries SET display_name = $2, url = $3, ref = $4, host_kind = $5,
            enabled = $6, trust_state = $7, allow_unsigned = $8, allow_private_host = $9
      WHERE slug = $1`,
    [slug,
      patch.displayName ?? current.displayName,
      url,
      (patch.ref ?? current.ref).trim(),
      patch.hostKind ?? (patch.url ? inferHostKind(url) : current.hostKind),
      patch.enabled ?? current.enabled,
      patch.trustState ?? current.trustState,
      patch.allowUnsigned ?? current.allowUnsigned,
      allowPrivateHost],
  ));
  if (patch.token !== undefined) await storeRegistryKey(pool, slug, patch.token);
  const updated = await getRegistry(pool, slug);
  if (!updated) throw new AppRegistryError(500, 'registry vanished during update');
  return updated;
}

/**
 * @description Removes a registry. The built-in row is never removable — disabling it is the
 * supported way to stop using the default store, so a deployment can always get back to a known
 * source. Removing does NOT uninstall anything it provided: that stays ADR-085's manual,
 * reverse-dependency-checked uninstall, deliberately.
 * @param pool - Postgres pool.
 * @param slug - the registry to remove.
 * @returns true when a row was removed.
 * @throws AppRegistryError 404 when absent, 409 for the built-in row.
 */
export async function removeRegistry(pool: Pool, slug: string): Promise<boolean> {
  const current = await getRegistry(pool, slug);
  if (!current) throw new AppRegistryError(404, `no registry named "${slug}"`);
  if (current.builtin) {
    throw new AppRegistryError(409, 'the built-in registry cannot be removed — disable it instead');
  }
  if (current.secretBackend === 'vault') {
    await new VaultConsoleService().write(vaultPath(slug), { token: '' }).catch((err) => {
      logger.warn({ err, slug }, 'could not clear the vault key for a removed registry');
    });
  }
  const { rowCount } = await runWithSystemIdentity(() => pool.query(
    'DELETE FROM app_registries WHERE slug = $1', [slug],
  ));
  logger.warn({ slug }, 'app registry removed');
  return (rowCount ?? 0) > 0;
}

/**
 * @description Records the outcome of a catalog read, so the loader page can show a registry as
 * healthy or broken instead of silently listing nothing.
 * @param pool - Postgres pool.
 * @param slug - the registry.
 * @param result - success flag, package count, and the failure reason when not ok.
 * @returns Resolves when recorded.
 */
export async function recordFetchOutcome(
  pool: Pool, slug: string, result: { ok: boolean; packageCount?: number; error?: string },
): Promise<void> {
  await runWithSystemIdentity(() => pool.query(
    `UPDATE app_registries SET last_fetch_at = NOW(), last_fetch_ok = $2,
            last_fetch_error = $3, package_count = $4 WHERE slug = $1`,
    [slug, result.ok, result.ok ? null : (result.error ?? 'unknown'), result.packageCount ?? null],
  ));
}

/**
 * @description Seeds the built-in registry from OSHAL_STORE_REPO / OSHAL_STORE_REF the first
 * time this runs, so an existing deployment adopts registries with ZERO configuration change and
 * its store keeps working exactly as before. Idempotent: once the row exists this never rewrites
 * it, because an operator may legitimately have re-pointed the built-in store since.
 * @param pool - Postgres pool.
 * @returns The built-in registry.
 */
export async function seedBuiltinRegistry(pool: Pool): Promise<AppRegistry> {
  const existing = await runWithSystemIdentity(() => pool.query(
    `SELECT ${COLS} FROM app_registries WHERE builtin = TRUE LIMIT 1`,
  ));
  if (existing.rows.length) return toRegistry(existing.rows[0]);

  const url = normalizeRepoUrl(
    process.env.OSHAL_STORE_REPO || 'https://github.com/emeraldcoastsystemsgroup/oshal-apps',
  );
  const ref = (process.env.OSHAL_STORE_REF || 'main').trim();
  await runWithSystemIdentity(() => pool.query(
    `INSERT INTO app_registries
       (id, slug, display_name, url, ref, host_kind, builtin, enabled, trust_state, trust_note)
     VALUES ($1,'oshal-store','OSHAL app store',$2,$3,$4,TRUE,TRUE,'trusted',
             'seeded from OSHAL_STORE_REPO at first boot')
     ON CONFLICT (slug) DO NOTHING`,
    [crypto.randomUUID(), url, ref, inferHostKind(url)],
  ));
  logger.info({ url, ref }, 'built-in app registry seeded from the environment');
  const created = await getRegistry(pool, 'oshal-store');
  if (!created) throw new AppRegistryError(500, 'built-in registry could not be seeded');
  return created;
}
