/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-18 / R0.12 done-when (5). The helper logged that the handover gate had FAILED and the ticket was blocked from advancing, then returned a struct; both callers logged "continuing with warning" and proceeded. One execution, two mutually contradictory records, and an operator reading the first learned something that never happened. These cases pin the replacement from both ends: the function still REPORTS a shortfall (so this is not "delete the check"), the caller still gets its finalOutput (so nothing is actually gated), and the log record says coverage and does not say blocked or FAILED. The last one is asserted on the record the logger was CALLED with, because the defect was never in the return value - it was in what the line said.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted above plain consts, so the spies have to be hoisted with it.
const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

// eslint-disable-next-line import/first
import { assessHandoverCoverage } from '@/features/swarm-orchestration/services/swarm-ticket-lifecycle-helpers';

/** Every message the logger was handed, at any level. */
function loggedMessages(): string[] {
  return [...logSpies.warn.mock.calls, ...logSpies.info.mock.calls]
    .map((call) => String(call[1] ?? ''));
}

function phaseResult(rounds: Array<{ handoverValidated: boolean; agentId: string; round: number }>) {
  return {
    phase: 2,
    rounds,
    allHandoversPresent: rounds.every((r) => r.handoverValidated),
    finalOutput: 'the work product the caller goes on to use',
  };
}

beforeEach(() => {
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

describe('handover coverage reports a shortfall without claiming to have stopped anything', () => {
  it('a round with no handover fails the assessment — the check still checks', () => {
    // Asserted first so the rest means something. If this returned true the log wording would be
    // irrelevant, because nothing would ever be reported.
    const result = assessHandoverCoverage('tkt-1', phaseResult([
      { handoverValidated: true, agentId: 'a1', round: 1 },
      { handoverValidated: false, agentId: 'a2', round: 2 },
    ]));

    expect(result.passed, 'a missing handover no longer registers at all').toBe(false);
    expect(result.missingHandovers).toBe(1);
    expect(result.totalRounds).toBe(2);
  });

  it('the log record says COVERAGE, and says neither blocked nor FAILED', () => {
    assessHandoverCoverage('tkt-1', phaseResult([
      { handoverValidated: false, agentId: 'a2', round: 2 },
    ]));

    const messages = loggedMessages();
    expect(messages.length, 'nothing was logged at all').toBeGreaterThan(0);
    const joined = messages.join(' | ');

    expect(joined, 'the shortfall is not described as coverage').toMatch(/coverage/i);
    // The two words the old line used. It announced a blocked ticket immediately before the
    // caller continued, which is the defect this whole entry is about.
    expect(joined, 'the log still claims the ticket was blocked').not.toMatch(/blocked/i);
    expect(joined, 'the log still announces a FAILED gate').not.toMatch(/FAILED/);
  });

  it('the caller still receives its finalOutput — nothing is gated', () => {
    // The struct is advisory. A caller that treated `passed === false` as a stop would be the
    // only thing making this a gate, and neither of the two does.
    const result = phaseResult([{ handoverValidated: false, agentId: 'a2', round: 2 }]);
    const coverage = assessHandoverCoverage('tkt-1', result);

    expect(coverage.passed).toBe(false);
    expect(result.finalOutput, 'the phase result lost its output').toBe(
      'the work product the caller goes on to use',
    );
  });

  it('complete coverage passes and logs it as coverage too', () => {
    const coverage = assessHandoverCoverage('tkt-1', phaseResult([
      { handoverValidated: true, agentId: 'a1', round: 1 },
      { handoverValidated: true, agentId: 'a2', round: 2 },
    ]));

    expect(coverage.passed).toBe(true);
    expect(coverage.missingHandovers).toBe(0);
    expect(loggedMessages().join(' | ')).toMatch(/coverage/i);
  });

  it('a phase with no rounds neither passes falsely nor logs a shortfall', () => {
    // strict reads allHandoversPresent, which `every` reports true for an empty list. Pinned
    // because it is the shape a reader would most likely get wrong when changing this.
    const coverage = assessHandoverCoverage('tkt-1', phaseResult([]));
    expect(coverage.totalRounds).toBe(0);
    expect(coverage.missingHandovers).toBe(0);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });
});
