/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added static security contracts for auth-gated server wiring and forced owner RLS migration coverage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('ambient-listening security wiring', () => {
  it('mounts the complete route tree behind requiresAuth', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/app/server.ts'), 'utf8');
    expect(source).toContain("app.use('/api/jarvis/ambient', requiresAuth, createAmbientListeningRoutes(ctx))");
    expect(source).toContain('startAmbientReviewRuntime(ctx.pool)');
  });

  it('forces owner RLS on settings, transcript segments, and reviews', () => {
    const migration = fs.readFileSync(path.join(ROOT, 'scripts/migrations/068-ambient-listening.sql'), 'utf8');
    const service = fs.readFileSync(
      path.join(ROOT, 'src/features/ambient-listening/services/ambient-listening-service.ts'),
      'utf8',
    );
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(migration).toContain("user_sub = current_setting('oshal.current_sub', true)");
    expect(migration).toContain('ambient_enabled           BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('daily_review_enabled      BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain("daily_review_time         TIME NOT NULL DEFAULT '21:00'");
    expect(migration).not.toMatch(/\baudio_(?:data|blob|bytes)\b/i);
    expect(service).toContain('if (!settings.ambientEnabled && !allowWhenAmbientDisabled)');
    expect(service).toContain("mode === 'recording_import'");
    expect(service).toContain('settings.transcript_retention_days * INTERVAL');
  });
});
