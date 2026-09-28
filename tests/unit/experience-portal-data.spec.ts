/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the full-swarm build's pure readers headlessly over the shipped scripts: every canonical ticket state folds to a label one of the shared status groups places (approval gates and customer actions need the person, every in_process_* phase is Working, approved waits for the queue).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Classic browser scripts with a CommonJS export seam; the shipped files themselves are loaded.
const LIVE = require('../../src/experience/live-data.js') as Record<string, any>;

/** The canonical ticket states (OshalTicketStateSchema in src/entities/ticket/types.ts), copied so a new state shows up here as a failing case. */
const CANONICAL_STATES = ['backlog', 'approved', 'in_process', 'in_process_discovery', 'in_process_design', 'in_process_build', 'in_process_deploy', 'in_process_test',
  'in_process_release', 'approval_required', 'customer_action', 'complete', 'escalated', 'dead_letter', 'paused', 'cancelled'];

describe('status fold over the canonical ticket states', () => {
  it('places every canonical state in exactly one shared group', () => {
    const groups = LIVE.STATUS_GROUPS as Record<string, string[]>;
    for (const state of CANONICAL_STATES) {
      const label = LIVE.statusOf(state).label;
      const homes = Object.keys(groups).filter(g => groups[g].includes(label));
      expect(homes, `${state} -> ${label}`).toHaveLength(1);
    }
  });

  it('names the states that wait on a person and the phases that are moving', () => {
    expect(LIVE.statusOf('approval_required')).toMatchObject({ label: 'Approval required', tone: 'warn', open: true });
    expect(LIVE.statusOf('customer_action')).toMatchObject({ label: 'Needs you', tone: 'warn', open: true });
    expect(LIVE.statusOf('dead_letter')).toMatchObject({ label: 'Blocked', tone: 'warn', open: true });
    expect(LIVE.statusOf('approved')).toMatchObject({ label: 'Approved', open: true });
    for (const phase of ['in_process_discovery', 'in_process_build', 'in_process_release', 'In-Process-Test']) expect(LIVE.statusOf(phase).label, phase).toBe('Working');
    expect(LIVE.STATUS_GROUPS.attention).toEqual(expect.arrayContaining(['Approval required', 'Needs you', 'Review', 'Blocked']));
    expect(LIVE.STATUS_GROUPS.moving).toEqual(expect.arrayContaining(['Working', 'Queued', 'Approved']));
  });

  it('keeps an unknown status readable and outside every group', () => {
    expect(LIVE.statusOf('needs_owner_review').label).toBe('Needs owner review');
    const all = Object.values(LIVE.STATUS_GROUPS as Record<string, string[]>).flat();
    expect(all).not.toContain('Needs owner review');
  });
});
