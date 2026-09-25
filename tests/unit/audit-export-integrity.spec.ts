/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove audit export chains detect edits, reordering, truncation, and invalid operator signatures while accepting a byte-stable clean artifact.
 */
import { describe, expect, it } from 'vitest';
import {
  auditExportIntegrityHeaders,
  buildAuditExportArtifact,
  verifyAuditExportArtifact,
} from '@/features/governance/audit/audit-export-integrity';
import type { AuditRow } from '@/features/governance/audit/audit-emit';

const rows: AuditRow[] = [
  { audit_id: 'a', actor_sub: 'user-a', action: 'ticket.read', resource_type: 'ticket', resource_id: 't1', decision: 'allow', metadata: { scope: 'own' }, created_at: '2026-09-24T12:00:00.000Z' },
  { audit_id: 'b', actor_sub: 'user-a', action: 'ticket.write', resource_type: 'ticket', resource_id: 't1', decision: 'deny', metadata: null, created_at: '2026-09-24T12:01:00.000Z' },
];

describe('audit export integrity', () => {
  it('builds and verifies a deterministic chain with an optional operator signature', () => {
    const artifact = buildAuditExportArtifact(rows, 'operator-key');
    expect(verifyAuditExportArtifact(artifact, { operatorKey: 'operator-key' })).toMatchObject({ valid: true, count: 2 });
    expect(buildAuditExportArtifact(rows, 'operator-key').integrity).toEqual(artifact.integrity);
    expect(auditExportIntegrityHeaders(artifact.integrity)[0]).toContain('sha256-chain-v1');
  });

  it('detects row edits and reordering', () => {
    const artifact = buildAuditExportArtifact(rows);
    expect(verifyAuditExportArtifact({ ...artifact, rows: [{ ...rows[0], action: 'ticket.delete' }, rows[1]] })).toMatchObject({ valid: false, reason: 'chain_head_mismatch' });
    expect(verifyAuditExportArtifact({ ...artifact, rows: [...rows].reverse() })).toMatchObject({ valid: false, reason: 'chain_head_mismatch' });
  });

  it('detects truncation and refuses a signed artifact without its operator key', () => {
    const artifact = buildAuditExportArtifact(rows, 'operator-key');
    expect(verifyAuditExportArtifact({ ...artifact, rows: rows.slice(0, 1) })).toMatchObject({ valid: false, reason: 'count_mismatch_or_truncation' });
    expect(verifyAuditExportArtifact(artifact)).toMatchObject({ valid: false, reason: 'operator_key_required' });
    expect(verifyAuditExportArtifact(artifact, { operatorKey: 'wrong-key' })).toMatchObject({ valid: false, reason: 'signature_mismatch' });
  });

  it('detects replacement of the retained external anchor', () => {
    const artifact = buildAuditExportArtifact(rows, 'operator-key');
    expect(verifyAuditExportArtifact(artifact, { operatorKey: 'operator-key', expectedHead: '0'.repeat(64) })).toMatchObject({ valid: false, reason: 'external_head_mismatch' });
  });
});
