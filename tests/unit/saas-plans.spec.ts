import { describe, expect, it } from 'vitest';
import { evaluatePlanLimits, getPublicPlan, listPublicPlans, PublicPlanId } from '../../src/features/saas';

describe('public self-serve SaaS plan foundation', () => {
  it('defines public and pilot plans with quotas', () => {
    const plans = listPublicPlans();

    expect(plans.map((plan) => plan.id)).toEqual([
      PublicPlanId.Free,
      PublicPlanId.HomePro,
      PublicPlanId.Team,
      PublicPlanId.EnterprisePilot,
    ]);
    expect(plans.every((plan) => plan.hosted)).toBe(true);
    expect(plans.every((plan) => plan.seats > 0 && plan.connectorLimit > 0 && plan.monthlyTaskLimit > 0)).toBe(true);
  });

  it('returns null for unknown plans', () => {
    expect(getPublicPlan('unknown')).toBeNull();
  });

  it('blocks usage over seat, connector, task, and token limits', () => {
    const plan = getPublicPlan(PublicPlanId.Free);
    expect(plan).toBeTruthy();

    const decision = evaluatePlanLimits(plan!, {
      seatsUsed: 2,
      connectorsEnabled: 4,
      monthlyTasks: 101,
      monthlyTokenSpendUsd: 6,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual(['seat_limit', 'connector_limit', 'task_limit', 'token_budget']);
  });
});
