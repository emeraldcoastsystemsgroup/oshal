export const PublicPlanId = {
  Free: 'free',
  HomePro: 'home-pro',
  Team: 'team',
  EnterprisePilot: 'enterprise-pilot',
} as const;

export type PublicPlanId = (typeof PublicPlanId)[keyof typeof PublicPlanId];

export interface PublicPlan {
  id: PublicPlanId;
  label: string;
  monthlyUsd: number | null;
  seats: number;
  connectorLimit: number;
  monthlyTaskLimit: number;
  monthlyTokenBudgetUsd: number;
  hosted: boolean;
  support: 'community' | 'standard' | 'pilot';
}

export interface PlanUsageSnapshot {
  seatsUsed: number;
  connectorsEnabled: number;
  monthlyTasks: number;
  monthlyTokenSpendUsd: number;
}

export interface PlanLimitDecision {
  allowed: boolean;
  blockers: string[];
}

export const PUBLIC_PLAN_CATALOG: readonly PublicPlan[] = [
  {
    id: PublicPlanId.Free,
    label: 'Free',
    monthlyUsd: 0,
    seats: 1,
    connectorLimit: 3,
    monthlyTaskLimit: 100,
    monthlyTokenBudgetUsd: 5,
    hosted: true,
    support: 'community',
  },
  {
    id: PublicPlanId.HomePro,
    label: 'Home AI Pro',
    monthlyUsd: 19,
    seats: 3,
    connectorLimit: 20,
    monthlyTaskLimit: 1000,
    monthlyTokenBudgetUsd: 50,
    hosted: true,
    support: 'standard',
  },
  {
    id: PublicPlanId.Team,
    label: 'Team',
    monthlyUsd: 79,
    seats: 10,
    connectorLimit: 75,
    monthlyTaskLimit: 5000,
    monthlyTokenBudgetUsd: 250,
    hosted: true,
    support: 'standard',
  },
  {
    id: PublicPlanId.EnterprisePilot,
    label: 'Enterprise Pilot',
    monthlyUsd: null,
    seats: 25,
    connectorLimit: 150,
    monthlyTaskLimit: 20000,
    monthlyTokenBudgetUsd: 1000,
    hosted: true,
    support: 'pilot',
  },
] as const;

export function listPublicPlans(): readonly PublicPlan[] {
  return PUBLIC_PLAN_CATALOG;
}

export function getPublicPlan(id: string): PublicPlan | null {
  return PUBLIC_PLAN_CATALOG.find((plan) => plan.id === id) ?? null;
}

export function evaluatePlanLimits(plan: PublicPlan, usage: PlanUsageSnapshot): PlanLimitDecision {
  const blockers: string[] = [];
  if (usage.seatsUsed > plan.seats) blockers.push('seat_limit');
  if (usage.connectorsEnabled > plan.connectorLimit) blockers.push('connector_limit');
  if (usage.monthlyTasks > plan.monthlyTaskLimit) blockers.push('task_limit');
  if (usage.monthlyTokenSpendUsd > plan.monthlyTokenBudgetUsd) blockers.push('token_budget');
  return { allowed: blockers.length === 0, blockers };
}
