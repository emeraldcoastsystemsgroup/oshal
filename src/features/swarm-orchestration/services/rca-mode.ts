/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted readRcaMode + INCIDENT_MODE_DISPOSITION out of queue-manager-service so the Argo batch path (bot-node-batch.ts, finalize-incident.ts) reads the mode from the SAME canonical source as the in-process pipeline, instead of re-deriving it. Importing queue-manager-service from a batch pod would drag the whole queue manager (Redis, dispatch) into a one-shot Job; this module has no such weight. queue-manager-service re-exports both, so every existing call site and test is unchanged.
 */

/**
 * The RCA mode contract — one definition, shared by the in-process pipeline and the
 * Argo batch path.
 *
 * The RCA personas stamp their disposition on **line 1 of RCA-REPORT.md**, exactly as
 * `MODE: A (remediation)` / `MODE: B (info-request)` / `MODE: C (escalate)` (see
 * `ai-lab/bot-personas/rca-specialist.yaml`). That file is the source of truth — NOT the
 * free-text response — so anything that needs the mode must read it from there.
 *
 * @module rca-mode
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OshalTicketState } from '@/entities/ticket';

/**
 * @description How each classified mode disposes of the incident ticket (ADR-069 §2b).
 * Mode A/B hand back to the customer; mode C escalates.
 */
export const INCIDENT_MODE_DISPOSITION: Record<'A' | 'B' | 'C', { status: OshalTicketState; disposition: string }> = {
  A: { status: 'customer_action', disposition: 'proposed_solution' },
  B: { status: 'customer_action', disposition: 'human_action_needed' },
  C: { status: 'escalated', disposition: 'escalated' },
};

/**
 * @description Reads the worker's chosen mode from line 1 of RCA-REPORT.md.
 * @param delivDir - The worker's deliverables directory holding RCA-REPORT.md.
 * @returns The mode letter, or null when the file or marker is absent (callers fall back).
 */
export function readRcaMode(delivDir: string): 'A' | 'B' | 'C' | null {
  try {
    const reportPath = path.join(delivDir, 'RCA-REPORT.md');
    if (!fs.existsSync(reportPath)) return null;
    const firstLine = fs.readFileSync(reportPath, 'utf8').split(/\r?\n/, 1)[0] || '';
    const match = firstLine.match(/^\s*MODE:\s*([ABC])\b/i);
    return match ? (match[1].toUpperCase() as 'A' | 'B' | 'C') : null;
  } catch {
    return null;
  }
}
