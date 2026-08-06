/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Guard the nightly own-data evidence path against regression to loopback/in-memory proof.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCompetitiveEvidence } from '../../scripts/evidence/competitive-score-evidence';
import { buildProcurementSaasReadiness } from '../../scripts/evidence/procurement-saas-readiness';

const generator = readFileSync('scripts/evidence/prove-own-data-live.ts', 'utf8');
const databaseHelper = readFileSync('tests/helpers/own-data-database-evidence.ts', 'utf8');
const privacySpec = readFileSync('tests/live/privacy-export-delete.live.spec.ts', 'utf8');
const isolationSpec = readFileSync('tests/live/two-user-isolation.live.spec.ts', 'utf8');

describe('nightly own-data live evidence contract', () => {
  it('executes both signed-in route specs and requires their structured database proof', () => {
    expect(generator).toContain('tests/live/privacy-export-delete.live.spec.ts');
    expect(generator).toContain('tests/live/two-user-isolation.live.spec.ts');
    expect(generator).toContain("OSHAL_OWN_DATA_DATABASE_EVIDENCE: 'true'");
    expect(generator).toContain('did not prove its fixtures reached Postgres');
    expect(generator).toContain("proofTier: 'live'");
  });

  it('cannot silently return to loopback stores or fake route authentication', () => {
    expect(generator).not.toContain('seedStores()');
    expect(generator).not.toContain('buildPrivacyCtx');
    expect(generator).not.toContain('fakeAuth');
    expect(generator).not.toContain("proofTier: 'loopback-integration'");
  });

  it('checks exact rows through the app identity GUC and rejects privileged database roles', () => {
    expect(databaseHelper).toContain("set_config('oshal.current_sub'");
    expect(databaseHelper).toContain('FROM chat_tasks');
    expect(databaseHelper).toContain('FROM tickets');
    expect(isolationSpec).toContain('expect(databaseA.superuser).toBe(false)');
    expect(isolationSpec).toContain('expect(databaseA.bypassRls).toBe(false)');
    expect(privacySpec).toContain('databaseAfterB.tasks.map');
    expect(privacySpec).toContain('databaseAfterB.tickets.map');
  });

  it('makes competitive and procurement gates reject the retired loopback/RLS-only evidence', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'oshal-own-data-score-'));
    const evidenceDir = join(repoRoot, 'docs', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const now = new Date('2026-08-06T12:00:00.000Z');
    const header = '**Proof-Tier:** live\nGenerated: 2026-08-06 06:00:00 +00:00\n';
    const isolationPath = join(evidenceDir, 'live-two-user-isolation-2026-08-06.md');
    const privacyPath = join(evidenceDir, 'data-export-delete-2026-08-06.md');
    try {
      writeFileSync(isolationPath, `${header}user A and user B cannot read cross-user rows\n`, 'utf8');
      writeFileSync(privacyPath, `${header}export and delete passed through loopback stores\n`, 'utf8');
      expect(ownDataCompetitiveChecks(repoRoot, now)).toEqual({ isolation: 'missing', privacy: 'missing' });
      expect(ownDataProcurementGates(repoRoot, now)).toEqual({ isolation: 'missing', privacy: 'missing' });

      writeFileSync(isolationPath, `${header}user A and user B cannot read cross-user rows; signed-in route fixtures reached Postgres\n`, 'utf8');
      writeFileSync(privacyPath, `${header}export and delete passed on Postgres through oshal_app\n`, 'utf8');
      expect(ownDataCompetitiveChecks(repoRoot, now)).toEqual({ isolation: 'pass', privacy: 'pass' });
      expect(ownDataProcurementGates(repoRoot, now)).toEqual({ isolation: 'pass', privacy: 'pass' });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function ownDataCompetitiveChecks(repoRoot: string, now: Date): { isolation?: string; privacy?: string } {
  const ownData = buildCompetitiveEvidence(repoRoot, { now }).categories.find((category) => category.id === 'own-data');
  return {
    isolation: ownData?.checks.find((check) => check.id === 'live-two-user')?.status,
    privacy: ownData?.checks.find((check) => check.id === 'export-delete')?.status,
  };
}

function ownDataProcurementGates(repoRoot: string, now: Date): { isolation?: string; privacy?: string } {
  const enterprise = buildProcurementSaasReadiness(repoRoot, { now }).tracks
    .find((track) => track.id === 'enterprise-procurement');
  return {
    isolation: enterprise?.gates.find((gate) => gate.id === 'two-user-isolation-live')?.status,
    privacy: enterprise?.gates.find((gate) => gate.id === 'data-export-delete-live')?.status,
  };
}
