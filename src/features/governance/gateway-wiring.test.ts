import { describe, it, expect } from 'vitest';
import { governLlmCall } from '@/features/llm-provider';

// Phase 4 wires governLlmCall into the haven LLM dispatch chokepoint. The wiring relies on a
// specific contract: when LLM governance is OFF (default), the gateway must allow the call and
// return the model UNCHANGED (no DB access, no behavior change). These tests pin that contract so
// the dispatch wiring stays a true no-op until an operator opts in via OSHAL_LLM_BUDGETS.

const OFF = {} as unknown as NodeJS.ProcessEnv;

describe('governLlmCall — off-by-default contract the dispatch wiring depends on', () => {
  it('allows and leaves the model unchanged when enforcement is off', async () => {
    const r = await governLlmCall(
      { requestedModel: 'gpt-5.1', scope: 'global', key: 'haven' },
      { env: OFF, pool: null },
    );
    expect(r.allowed).toBe(true);
    expect(r.model).toBe('gpt-5.1');
    expect(r.downshiftedFrom).toBeNull();
    expect(r.reason).toBe('enforcement-off');
  });

  it('does not require a DB pool on the off path', async () => {
    // pool intentionally omitted — off path must not touch the DB.
    await expect(
      governLlmCall({ requestedModel: 'claude-opus-4-8', scope: 'global', key: 'haven' }, { env: OFF }),
    ).resolves.toMatchObject({ allowed: true, model: 'claude-opus-4-8' });
  });
});
