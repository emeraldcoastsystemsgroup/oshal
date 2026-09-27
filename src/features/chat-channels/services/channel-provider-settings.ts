/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the operator-level chat-channel provider settings store (migration 171, mirrored here). Tonight's Discord setup needed an .env edit, an api container recreate and a hand-minted SQL link code; this table is what lets an operator paste a bot token into the cockpit instead. The secret is encrypted before it reaches the row through an injected cipher (the app layer passes the connector-token cipher, so the same at-rest protection connectors get applies) and is decrypted only for the process that opens the Gateway; nothing here ever logs it or returns it to a caller. The table is operator-only under forced RLS, so a non-operator connection sees no row even if a route bug reached it.
 */

import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

const logger = createChildLogger({ module: 'channel-provider-settings' });

/** Minimal pool surface this store needs (avoids a hard pg dependency in the type). */
interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/**
 * The at-rest cipher for a provider secret. The app layer supplies the connector-token cipher;
 * a spec may supply its own. Encrypt runs before any row is written and decrypt only for the
 * in-process consumer, so the plaintext never crosses this store's boundary in either direction.
 */
export interface ProviderSecretCipher {
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

/** One provider's saved settings, without the secret. */
export interface ChannelProviderSettings {
  provider: string;
  enabled: boolean;
  /** True when an encrypted secret is stored (the secret itself is never returned here). */
  hasSecret: boolean;
  /** Provider-reported facts about the saved secret (bot id and name, application id, intent flag). */
  metadata: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: string;
}

/** Every column a ChannelProviderSettings is read from. */
const SETTINGS_COLUMNS = 'provider, enabled, secret_ciphertext IS NOT NULL AS has_secret, metadata, updated_by, updated_at';

/**
 * @description Stores each chat provider's operator-level configuration: enabled flag, the
 * encrypted bot secret and the metadata the provider reported for it. Reads and writes must run
 * under an operator or system identity — the table is operator-only under forced RLS.
 */
export class ChannelProviderSettingsStore {
  private readonly pool: QueryablePool;
  private readonly cipher: ProviderSecretCipher;
  private schemaReady = false;

  constructor(pool: QueryablePool, cipher: ProviderSecretCipher) {
    this.pool = pool;
    this.cipher = cipher;
  }

  /** @description Idempotently creates the settings table with its operator-only policy (once per process). */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await runRuntimeSchemaBootstrap({
      pool: this.pool as never,
      moduleName: 'chat-channel provider settings',
      statements: [
        `CREATE TABLE IF NOT EXISTS channel_provider_settings (
          provider TEXT PRIMARY KEY,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          secret_ciphertext TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        'ALTER TABLE channel_provider_settings ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE channel_provider_settings FORCE ROW LEVEL SECURITY',
        `DO $$
         BEGIN
           IF NOT EXISTS (
             SELECT 1 FROM pg_policy
             WHERE polname = 'channel_provider_settings_operator_only'
               AND polrelid = 'channel_provider_settings'::regclass
           ) THEN
             CREATE POLICY channel_provider_settings_operator_only ON channel_provider_settings
               AS PERMISSIVE FOR ALL
               USING (current_setting('oshal.is_operator', true) = 'on')
               WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
           END IF;
         END $$`,
      ],
      requirements: [
        { table: 'channel_provider_settings', columns: ['provider', 'enabled', 'secret_ciphertext', 'metadata', 'updated_by', 'updated_at'] },
      ],
    });
    this.schemaReady = true;
  }

  /**
   * @description Saves a provider's secret (encrypted) and metadata, enabling the provider.
   * @param provider - The channel provider key (e.g. 'discord').
   * @param secret - The plaintext bot secret; encrypted before the write, never logged.
   * @param metadata - What the provider reported for the secret.
   * @param updatedBy - The operator's sub, for the audit column.
   * @returns The saved settings (without the secret).
   */
  async save(provider: string, secret: string, metadata: Record<string, unknown>, updatedBy: string): Promise<ChannelProviderSettings> {
    await this.ensureSchema();
    const ciphertext = await this.cipher.encrypt(secret);
    const res = await this.pool.query(
      `INSERT INTO channel_provider_settings (provider, enabled, secret_ciphertext, metadata, updated_by, updated_at)
       VALUES ($1, TRUE, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (provider) DO UPDATE SET enabled = TRUE, secret_ciphertext = EXCLUDED.secret_ciphertext,
         metadata = EXCLUDED.metadata, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${SETTINGS_COLUMNS}`,
      [provider, ciphertext, JSON.stringify(metadata), updatedBy],
    );
    logger.info({ provider, updatedBy }, 'channel provider settings saved');
    return this.mapRow(res.rows[0]);
  }

  /**
   * @description Disables a provider and forgets its secret and metadata. The row stays so the
   * decision is durable: an env-seeded token does not re-enable the provider on the next boot.
   * @param provider - The channel provider key.
   * @param updatedBy - The operator's sub.
   * @returns The disabled settings.
   */
  async disable(provider: string, updatedBy: string): Promise<ChannelProviderSettings> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `INSERT INTO channel_provider_settings (provider, enabled, secret_ciphertext, metadata, updated_by, updated_at)
       VALUES ($1, FALSE, NULL, '{}'::jsonb, $2, NOW())
       ON CONFLICT (provider) DO UPDATE SET enabled = FALSE, secret_ciphertext = NULL, metadata = '{}'::jsonb,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${SETTINGS_COLUMNS}`,
      [provider, updatedBy],
    );
    logger.info({ provider, updatedBy }, 'channel provider disabled and its secret forgotten');
    return this.mapRow(res.rows[0]);
  }

  /**
   * @description Reads a provider's settings without the secret.
   * @param provider - The channel provider key.
   * @returns The settings, or null when the operator never configured the provider.
   */
  async read(provider: string): Promise<ChannelProviderSettings | null> {
    await this.ensureSchema();
    const res = await this.pool.query(`SELECT ${SETTINGS_COLUMNS} FROM channel_provider_settings WHERE provider = $1`, [provider]);
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  /**
   * @description Decrypts a provider's stored secret for the in-process consumer (the Gateway).
   * @param provider - The channel provider key.
   * @returns The plaintext secret, or null when the provider is disabled or has none.
   */
  async readSecret(provider: string): Promise<string | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      'SELECT secret_ciphertext FROM channel_provider_settings WHERE provider = $1 AND enabled AND secret_ciphertext IS NOT NULL',
      [provider],
    );
    const row = res.rows[0] as { secret_ciphertext?: unknown } | undefined;
    if (!row?.secret_ciphertext) return null;
    return this.cipher.decrypt(String(row.secret_ciphertext));
  }

  private mapRow(row: unknown): ChannelProviderSettings {
    const r = row as Record<string, unknown>;
    const metadata = r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : {};
    return {
      provider: String(r.provider),
      enabled: r.enabled === true,
      hasSecret: r.has_secret === true,
      metadata,
      updatedBy: r.updated_by == null ? null : String(r.updated_by),
      updatedAt: String(r.updated_at),
    };
  }
}
