/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2-4 wiring guard: the Ambient Recall surface follows the cockpit theme (it hardcoded midnight and ignored the operator's pick), carries the Asks / People / Trends views, the routes expose the profile + trend reads behind the fail-closed wrapper, Jarvis chat goes through the person-model front door, migration 138 carries the parity triggers, and the semantic collection is kernel-reserved.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { KERNEL_RESERVED_RAG_COLLECTIONS } from '@/features/rag';

const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

describe('Ambient Recall surface + wiring (ADR-100 Phases 2-4)', () => {
  const html = read('src/api/person-model.html');
  const routes = read('src/app/routes/person-model-routes.ts');
  const jarvis = read('src/app/routes/jarvis-routes.ts');
  const migration = read('scripts/migrations/138-person-model-parity.sql');
  const runtime = read('src/app/ambient-enrichment-runtime.ts');

  it('follows the cockpit theme live: the shared theme script loads right after the token stylesheet', () => {
    const css = html.indexOf('/shared/ui/css/surface-themes.css');
    const js = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(css).toBeGreaterThan(-1);
    expect(js).toBeGreaterThan(css);
    expect(js).toBeLessThan(html.indexOf('<style>'));
  });

  it('carries the Asks, People (profile tabs) and Trends views and labels inferences as not counted', () => {
    for (const marker of [
      'data-panel="recall"', 'data-panel="asks"', 'data-panel="people"', 'data-panel="trends"',
      "'/profile/'", "'/people'", "'/asks'", "'/consents'", "'/trends?weeks='", "'/connections?a='", "'/projection'",
      'Possibly related', 'not counted', "OSHAL\\'s read", 'data-sub="', 'renderTopics(', 'renderPresence(', 'renderConsent(',
    ]) {
      expect(html, marker).toContain(marker);
    }
  });

  it('exposes the Phase 3/4 reads behind the fail-closed personRoute wrapper', () => {
    for (const path of ['/people', '/profile/:profileId', '/projection', '/trends', '/connections']) {
      expect(routes, path).toMatch(new RegExp(`router\\.get\\('${path.replace(/[/:]/g, (c) => `\\${c}`)}', personRoute\\(`));
    }
    expect(routes).toContain("related,");
    expect(routes).toContain('relatedRecall(ctx.pool, sub, intent, new Set(result.receipts.map((r) => r.segmentId)))');
  });

  it('routes Jarvis chat through the person-model front door, not a recall-only hook', () => {
    expect(jarvis).toMatch(/detectPersonModelIntent,\s+answerPersonModelIntent,\s+ownerHasAmbientData,\s+\} from '@\/features\/person-model'/);
    expect(jarvis).toContain('detectPersonModelIntent(message)');
    expect(jarvis).toContain('answer = await answerPersonModelIntent(ctx.pool, sub, recallIntent)');
    expect(jarvis).not.toContain('detectRecallIntent');
  });

  it('migration 138 carries every parity trigger and the pure-SQL rollup rebuild', () => {
    for (const name of ['pm_rebuild_rollups', 'pm_segment_deleted', 'pm_segment_repointed', 'pm_segments_repointed_stmt', 'pm_profile_deleting']) {
      expect(migration, name).toContain(`CREATE OR REPLACE FUNCTION ${name}(`);
    }
    expect(migration).toContain('AFTER DELETE ON ambient_transcript_segments');
    expect(migration).toContain('AFTER UPDATE OF speaker_profile_id ON ambient_transcript_segments');
    expect(migration).toContain('BEFORE DELETE ON ambient_speaker_profiles');
    expect(migration).toContain("to_regclass('public.rag_chunks')");
    expect(migration).toContain('maintainer@emeraldcoastsystemsgroup.com');
  });

  it('runs the projection sweep and the orphan backstop under SYSTEM identity in the runtime', () => {
    expect(runtime).toContain('const projected = await runProjectionSweep(ctx.pool);');
    expect(runtime).toContain('runWithSystemIdentity(() => runMaintenancePass(pool))');
    expect(runtime).toContain('purgeOrphanChunks(pool)');
  });

  it('reserves the ambient-recall collection for the kernel', () => {
    expect(KERNEL_RESERVED_RAG_COLLECTIONS).toContain('ambient-recall');
  });

  it('records the shipped phases in ADR-100 and the manifest', () => {
    expect(read('docs/adr/100-ambient-person-model.md')).toMatch(/Status:\*\* Accepted — Phases 1-4 shipped/);
    expect(read('swarm-apps/person-model.yaml')).toMatch(/^version: 1\.1\.0$/m);
  });
});
