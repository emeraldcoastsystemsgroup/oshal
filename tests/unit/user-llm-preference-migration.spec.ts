/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Guard the forward migration that keeps the database preference CHECK constraint byte-for-byte aligned with every value accepted by the application, including `bot-default`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LLM_PREFERENCE_IDS } from '@/app/routes/user-brain-resolution';

const migration = readFileSync(resolve('scripts/migrations/180-bot-default-user-llm-preference.sql'), 'utf8');

describe('user LLM preference database vocabulary', () => {
  it('replaces the named CHECK constraint with the exact application vocabulary', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS oshal_user_llm_prefs_preferred_provider_check');
    const check = migration.match(
      /ADD CONSTRAINT oshal_user_llm_prefs_preferred_provider_check\s+CHECK \(preferred_provider IN \(([\s\S]*?)\)\);/,
    );
    expect(check, 'migration must recreate the named preferred-provider CHECK').not.toBeNull();
    const allowed = [...check![1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    expect(allowed).toEqual([...LLM_PREFERENCE_IDS]);
  });
});
