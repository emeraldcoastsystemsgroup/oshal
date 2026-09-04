/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the 2026-09-04 fix: "enabled" gates the AUTOPILOT, not the operator. placeDecisionOrder's disabled-book BUY refusal is scoped to AUTONOMOUS decisions (analyst/rotation/ensemble/pop agents); an OPERATOR-authored buy (agent_id 'operator'/'pinned-lot'/'event-playbook') may buy a disabled book. Source guard — the live end-to-end BUY needs a broker; the branch condition is what regressed (a manual buy on the IRA was refused sell-only), so the guard pins the condition + that agent_id is read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

describe('disabled-book BUY refusal is scoped to the autopilot, not the operator (2026-09-04)', () => {
  const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');

  it('the decision SELECT reads agent_id so the engine can tell an operator order from an autonomous one', () => {
    expect(engine).toMatch(/SELECT action, symbol, side, qty, order_type,[^\n]*extended_hours, agent_id\n/);
  });

  it('an operator/pinned-lot/event-playbook decision is exempt; only an autonomous buy is refused on a disabled book', () => {
    expect(engine).toContain("const operatorAuthored = d.agent_id === 'operator' || d.agent_id === 'pinned-lot' || d.agent_id === 'event-playbook';");
    expect(engine).toContain('if (!book.enabled && d.side === \'buy\' && !operatorAuthored) {');
    // the bare unscoped refusal must be gone
    expect(engine).not.toMatch(/if \(!book\.enabled && d\.side === 'buy'\) \{/);
  });
});
