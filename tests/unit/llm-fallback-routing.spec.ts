/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for cost-aware, off-by-default model downshift routing (the ladder). Asserts: off = model unchanged; ladder picks the next cheaper model; near-cap downshifts instead of denying when a cheaper model exists.
 *
 * NOTE ON PATH: the task brief named tests/llm-fallback-routing.spec.ts. These
 * are pure vitest unit tests, so they live under tests/unit/ (vitest) to stay
 * out of the Playwright suite (testDir './tests', testIgnore 'tests/unit/**').
 * Filename preserved.
 */

import { describe, it, expect } from 'vitest';
import {
  selectModel,
  readRoutingConfig,
  familyOf,
  rungIndexFor,
  DEFAULT_LADDERS,
  type RoutingConfig,
} from '../../src/features/llm-provider/governance/fallback-routing';

const OFF: RoutingConfig = { enabled: false, policy: 'auto', nearCapThreshold: 0.85 };
const AUTO_ON: RoutingConfig = { enabled: true, policy: 'auto', nearCapThreshold: 0.85 };
const CHEAPEST_ON: RoutingConfig = { enabled: true, policy: 'cheapest', nearCapThreshold: 0.85 };
const NEVER_ON: RoutingConfig = { enabled: true, policy: 'never', nearCapThreshold: 0.85 };

describe('readRoutingConfig — off by default', () => {
  it('is disabled when OSHAL_LLM_BUDGETS is unset', () => {
    expect(readRoutingConfig({}).enabled).toBe(false);
  });
  it('defaults policy to auto and threshold to 0.85', () => {
    const cfg = readRoutingConfig({ OSHAL_LLM_BUDGETS: 'on' });
    expect(cfg.policy).toBe('auto');
    expect(cfg.nearCapThreshold).toBe(0.85);
  });
  it('parses policy + threshold', () => {
    const cfg = readRoutingConfig({ OSHAL_LLM_BUDGETS: 'on', OSHAL_ROUTING_POLICY: 'cheapest', OSHAL_ROUTING_NEAR_CAP_PCT: '0.5' });
    expect(cfg.policy).toBe('cheapest');
    expect(cfg.nearCapThreshold).toBe(0.5);
  });
  it('clamps threshold to [0,1]', () => {
    expect(readRoutingConfig({ OSHAL_LLM_BUDGETS: 'on', OSHAL_ROUTING_NEAR_CAP_PCT: '5' }).nearCapThreshold).toBe(1);
    expect(readRoutingConfig({ OSHAL_LLM_BUDGETS: 'on', OSHAL_ROUTING_NEAR_CAP_PCT: '-1' }).nearCapThreshold).toBe(0);
  });
});

describe('familyOf + rungIndexFor', () => {
  it('maps claude variants to the claude family', () => {
    expect(familyOf('claude-opus-4-1')).toBe('claude');
    expect(familyOf('claude-sonnet-4-6')).toBe('claude');
    expect(familyOf('haiku')).toBe('claude');
  });
  it('maps gpt/codex variants to the codex family', () => {
    expect(familyOf('gpt-5.4-codex')).toBe('codex');
    expect(familyOf('gpt-4.5')).toBe('codex');
  });
  it('returns null for unknown families', () => {
    expect(familyOf('gemini-2.5-pro')).toBeNull();
    expect(familyOf('')).toBeNull();
  });
  it('resolves a versioned id to its ladder rung', () => {
    expect(rungIndexFor('claude-opus-4-1', DEFAULT_LADDERS.claude)).toBe(0);
    expect(rungIndexFor('claude-sonnet-4-6', DEFAULT_LADDERS.claude)).toBe(1);
    expect(rungIndexFor('claude-haiku-4', DEFAULT_LADDERS.claude)).toBe(2);
    expect(rungIndexFor('gpt-5.4', DEFAULT_LADDERS.codex)).toBe(1);
  });
});

describe('selectModel — enforcement OFF = model unchanged (backward compat)', () => {
  it('returns the requested model untouched', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', budgetPressure: 0.99, config: OFF });
    expect(r.model).toBe('claude-opus-4-1');
    expect(r.downshiftedFrom).toBeNull();
    expect(r.reason).toBe('enforcement-off');
  });
});

describe('selectModel — policy never', () => {
  it('honors the requested model even under pressure', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', budgetPressure: 1, config: NEVER_ON });
    expect(r.model).toBe('claude-opus-4-1');
    expect(r.reason).toBe('policy-never');
  });
});

describe('selectModel — auto policy (downshift only under pressure)', () => {
  it('does NOT downshift when below the near-cap threshold', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', budgetPressure: 0.5, config: AUTO_ON });
    expect(r.model).toBe('claude-opus-4-1');
    expect(r.reason).toBe('not-under-pressure');
  });

  it('does NOT downshift when budget pressure is unknown', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', config: AUTO_ON });
    expect(r.model).toBe('claude-opus-4-1');
    expect(r.reason).toBe('not-under-pressure');
  });

  it('downshifts opus -> sonnet at/above the near-cap threshold', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', budgetPressure: 0.9, config: AUTO_ON });
    expect(r.model).toBe('sonnet');
    expect(r.downshiftedFrom).toBe('claude-opus-4-1');
    expect(r.reason).toBe('downshifted-near-cap');
  });

  it('steps exactly one rung (sonnet -> haiku)', () => {
    const r = selectModel({ requestedModel: 'claude-sonnet-4-6', budgetPressure: 0.95, config: AUTO_ON });
    expect(r.model).toBe('haiku');
  });

  it('does not downshift past the cheapest rung (haiku stays haiku)', () => {
    const r = selectModel({ requestedModel: 'claude-haiku-4', budgetPressure: 1, config: AUTO_ON });
    expect(r.model).toBe('claude-haiku-4');
    expect(r.reason).toBe('no-cheaper-model');
  });

  it('codex family: gpt-4.5 -> gpt-5.4 under pressure', () => {
    const r = selectModel({ requestedModel: 'gpt-4.5', budgetPressure: 0.9, config: AUTO_ON });
    expect(r.model).toBe('gpt-5.4');
    expect(r.downshiftedFrom).toBe('gpt-4.5');
  });

  it('leaves unknown families untouched', () => {
    const r = selectModel({ requestedModel: 'gemini-2.5-pro', budgetPressure: 1, config: AUTO_ON });
    expect(r.model).toBe('gemini-2.5-pro');
    expect(r.reason).toBe('unknown-family');
  });
});

describe('selectModel — cheapest policy', () => {
  it('jumps straight to the cheapest rung of the family', () => {
    const r = selectModel({ requestedModel: 'claude-opus-4-1', config: CHEAPEST_ON });
    expect(r.model).toBe('haiku');
    expect(r.reason).toBe('downshifted-cheapest');
  });
  it('is a no-op when already cheapest', () => {
    const r = selectModel({ requestedModel: 'haiku', config: CHEAPEST_ON });
    expect(r.model).toBe('haiku');
    expect(r.reason).toBe('no-cheaper-model');
  });
});
