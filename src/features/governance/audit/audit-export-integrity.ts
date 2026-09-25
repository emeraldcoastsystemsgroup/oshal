/**
 * Tamper-evident audit export envelope.
 *
 * The export is deliberately self-contained: every row is chained to the previous row and the
 * artifact carries the expected count and final head. A verifier can therefore detect edits,
 * re-ordering, and truncation without a database connection. Deployments may additionally set
 * OSHAL_AUDIT_EXPORT_KEY; in that case the final head is HMAC-signed so an operator can retain a
 * small external anchor rather than trusting a mutable copy of the export.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add deterministic SHA-256 audit export chains, optional operator-key HMAC anchors, and an offline verifier for JSON/CSV retention artifacts.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AuditRow } from './audit-emit';

export const AUDIT_EXPORT_CHAIN_ALGORITHM = 'sha256-chain-v1';
export const AUDIT_EXPORT_SIGNATURE_ALGORITHM = 'hmac-sha256';

export interface AuditExportIntegrity {
  algorithm: typeof AUDIT_EXPORT_CHAIN_ALGORITHM;
  count: number;
  genesis: string;
  head: string;
  signature: string | null;
  signatureAlgorithm: typeof AUDIT_EXPORT_SIGNATURE_ALGORITHM | null;
}

export interface AuditExportArtifact {
  count: number;
  rows: AuditRow[];
  integrity: AuditExportIntegrity;
}

const GENESIS = 'oshal-audit-export-genesis-v1';

function canonicalRow(row: AuditRow): string {
  return JSON.stringify([
    row.audit_id,
    row.actor_sub,
    row.action,
    row.resource_type,
    row.resource_id,
    row.decision,
    row.metadata ?? null,
    row.created_at,
  ]);
}

function digest(previous: string, row: AuditRow): string {
  return createHash('sha256').update(previous).update('\n').update(canonicalRow(row)).digest('hex');
}

function sign(head: string, operatorKey?: string): string | null {
  if (!operatorKey) return null;
  return createHmac('sha256', operatorKey).update(head).digest('hex');
}

/** Build the integrity metadata that travels with a JSON or CSV export. */
export function buildAuditExportArtifact(rows: AuditRow[], operatorKey?: string): AuditExportArtifact {
  let previous = GENESIS;
  for (const row of rows) previous = digest(previous, row);
  return {
    count: rows.length,
    rows,
    integrity: {
      algorithm: AUDIT_EXPORT_CHAIN_ALGORITHM,
      count: rows.length,
      genesis: GENESIS,
      head: previous,
      signature: sign(previous, operatorKey),
      signatureAlgorithm: operatorKey ? AUDIT_EXPORT_SIGNATURE_ALGORITHM : null,
    },
  };
}

export interface AuditExportVerifyOptions {
  /** The operator key, when the artifact carries a signature. */
  operatorKey?: string;
  /** An independently retained head/signature anchor, if available. */
  expectedHead?: string;
  expectedSignature?: string;
}

export interface AuditExportVerification {
  valid: boolean;
  reason: string | null;
  head: string | null;
  count: number;
}

/** Verify row content, order, count, final head, and (when supplied) the external HMAC anchor. */
export function verifyAuditExportArtifact(
  artifact: Pick<AuditExportArtifact, 'rows' | 'integrity'>,
  options: AuditExportVerifyOptions = {},
): AuditExportVerification {
  const { rows, integrity } = artifact;
  if (!integrity || integrity.algorithm !== AUDIT_EXPORT_CHAIN_ALGORITHM) {
    return { valid: false, reason: 'unsupported_or_missing_chain', head: null, count: rows?.length ?? 0 };
  }
  if (!Array.isArray(rows) || rows.length !== integrity.count) {
    return { valid: false, reason: 'count_mismatch_or_truncation', head: null, count: rows?.length ?? 0 };
  }
  let previous = integrity.genesis;
  for (const row of rows) previous = digest(previous, row);
  if (previous !== integrity.head) {
    return { valid: false, reason: 'chain_head_mismatch', head: previous, count: rows.length };
  }
  if (options.expectedHead && options.expectedHead !== previous) {
    return { valid: false, reason: 'external_head_mismatch', head: previous, count: rows.length };
  }
  const expectedSignature = options.expectedSignature ?? integrity.signature;
  if (expectedSignature) {
    if (!options.operatorKey) return { valid: false, reason: 'operator_key_required', head: previous, count: rows.length };
    const actual = sign(previous, options.operatorKey);
    const safeActual = Buffer.from(actual ?? '', 'utf8');
    const safeExpected = Buffer.from(expectedSignature, 'utf8');
    if (safeActual.length !== safeExpected.length || !timingSafeEqual(safeActual, safeExpected)) {
      return { valid: false, reason: 'signature_mismatch', head: previous, count: rows.length };
    }
  }
  return { valid: true, reason: null, head: previous, count: rows.length };
}

/** Header lines for a CSV retention artifact. CSV consumers can ignore comment lines. */
export function auditExportIntegrityHeaders(integrity: AuditExportIntegrity): string[] {
  return [
    `# oshal-audit-chain-algorithm: ${integrity.algorithm}`,
    `# oshal-audit-chain-count: ${integrity.count}`,
    `# oshal-audit-chain-genesis: ${integrity.genesis}`,
    `# oshal-audit-chain-head: ${integrity.head}`,
    `# oshal-audit-chain-signature: ${integrity.signature ?? ''}`,
  ];
}
