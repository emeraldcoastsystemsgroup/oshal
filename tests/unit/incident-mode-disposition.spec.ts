/**
 * ADR-069 §2b — the operations RCA workflow finalizer mapping.
 *
 * Proves the worker's MODE marker (line 1 of RCA-REPORT.md) maps to the right terminal ticket state:
 * Mode A/B → customer_action (with a disposition tag the queue surface renders), Mode C → escalated,
 * and a missing/absent marker falls back to 'complete' (preserving prior incident-rca behaviour).
 *
 * @module tests/unit/incident-mode-disposition
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { readRcaMode, INCIDENT_MODE_DISPOSITION } from '@/features/swarm-orchestration/services/queue-manager-service';

const tmpDirs: string[] = [];
function deliverablesWith(firstLine: string | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rca-deliv-'));
  tmpDirs.push(dir);
  if (firstLine !== null) writeFileSync(path.join(dir, 'RCA-REPORT.md'), `${firstLine}\n\n# Root cause\n…`, 'utf8');
  return dir;
}

afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

describe('readRcaMode', () => {
  it('reads the persona-stamped markers (MODE: A/B/C with a label)', () => {
    expect(readRcaMode(deliverablesWith('MODE: A (remediation)'))).toBe('A');
    expect(readRcaMode(deliverablesWith('MODE: B (info-request)'))).toBe('B');
    expect(readRcaMode(deliverablesWith('MODE: C (escalate)'))).toBe('C');
  });

  it('is case/space tolerant and only reads line 1', () => {
    expect(readRcaMode(deliverablesWith('  mode:  a  (remediation)'))).toBe('A');
  });

  it('returns null when there is no marker or no report (→ caller falls back to complete)', () => {
    expect(readRcaMode(deliverablesWith('# RCA Report'))).toBeNull(); // no MODE line
    expect(readRcaMode(deliverablesWith(null))).toBeNull();           // no RCA-REPORT.md at all
    expect(readRcaMode(path.join(tmpdir(), 'does-not-exist-xyz'))).toBeNull();
  });
});

describe('INCIDENT_MODE_DISPOSITION (ADR-069 §2b)', () => {
  it('A/B rest in customer_action with distinct dispositions; C escalates', () => {
    expect(INCIDENT_MODE_DISPOSITION.A).toEqual({ status: 'customer_action', disposition: 'proposed_solution' });
    expect(INCIDENT_MODE_DISPOSITION.B).toEqual({ status: 'customer_action', disposition: 'human_action_needed' });
    expect(INCIDENT_MODE_DISPOSITION.C).toEqual({ status: 'escalated', disposition: 'escalated' });
  });
});
