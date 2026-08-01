/**
 * Per-user TTS voice preferences (JVV-012) — which server speech provider + voice reads
 * answers aloud for a given user, persisted server-side so the choice follows the user
 * across devices and is honored by every surface that calls /api/voice/synthesize.
 *
 * Deliberately NOT part of ambient_user_settings: the spoken voice applies to all of
 * Jarvis (and any surface using the voice rail), not just ambient listening, and this
 * keeps the ambient normalization pipeline untouched.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — VoicePrefsStore over voice_user_prefs (user_sub PK): get/set/clear with runtime schema bootstrap. Provider/voice ids only — never provider secrets (connector boundary, JVV-012).
 *
 * @module voice-prefs-store
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

const logger = createChildLogger({ module: 'voice-prefs-store' });

/** A user's saved spoken-voice selection. Null provider means "swarm default". */
export interface VoiceUserPrefs {
  ttsProvider: string | null;
  ttsVoice: string | null;
}

/**
 * @description Owner-scoped persistence for the JVV-012 voice picker. Rows hold provider
 * and voice IDENTIFIERS only — provider credentials stay server-side in the registry/config.
 */
export class VoicePrefsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Create/validate the voice_user_prefs table (idempotent; policy-aware via
   * the shared runtime schema bootstrap — validate-only on hosted runtimes).
   * @returns Resolves when the schema is usable.
   */
  async ensureSchema(): Promise<void> {
    await runRuntimeSchemaBootstrap({
      pool: this.pool,
      moduleName: 'voice user prefs',
      statements: [
        `CREATE TABLE IF NOT EXISTS voice_user_prefs (
          user_sub TEXT PRIMARY KEY,
          tts_provider TEXT NOT NULL,
          tts_voice TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ],
      requirements: [
        { table: 'voice_user_prefs', columns: ['user_sub', 'tts_provider', 'tts_voice', 'updated_at'] },
      ],
    });
  }

  /**
   * @description The caller's saved voice selection, or null when they've never chosen
   * (→ the swarm default flow applies unchanged).
   * @param userSub - Owner OIDC sub.
   * @returns Saved prefs or null.
   */
  async get(userSub: string): Promise<VoiceUserPrefs | null> {
    const result = await this.pool.query(
      'SELECT tts_provider, tts_voice FROM voice_user_prefs WHERE user_sub = $1',
      [userSub],
    );
    const row = result.rows[0] as { tts_provider?: string; tts_voice?: string | null } | undefined;
    if (!row || !row.tts_provider) return null;
    return { ttsProvider: row.tts_provider, ttsVoice: row.tts_voice ?? null };
  }

  /**
   * @description Save the caller's voice selection (upsert). Callers MUST have validated
   * the provider exists and reports configured before persisting (JVV-012: an unconfigured
   * provider is never selectable).
   * @param userSub - Owner OIDC sub.
   * @param providerId - TTS provider id (e.g. "google-cloud-tts").
   * @param voiceId - Optional voice id within that provider.
   * @returns Resolves when persisted.
   */
  async set(userSub: string, providerId: string, voiceId: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO voice_user_prefs (user_sub, tts_provider, tts_voice, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_sub) DO UPDATE SET tts_provider = $2, tts_voice = $3, updated_at = NOW()`,
      [userSub, providerId, voiceId],
    );
    logger.info({ userSub, providerId, voiceId }, 'voice prefs saved');
  }

  /**
   * @description Remove the caller's selection — back to the swarm default flow.
   * @param userSub - Owner OIDC sub.
   * @returns Resolves when cleared.
   */
  async clear(userSub: string): Promise<void> {
    await this.pool.query('DELETE FROM voice_user_prefs WHERE user_sub = $1', [userSub]);
    logger.info({ userSub }, 'voice prefs cleared (swarm default)');
  }
}
