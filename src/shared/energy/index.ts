/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — barrel for the harvest-agnostic energy
 *                     |                             | budget extracted from the marine slice, so a second harvest
 *                     |                             | domain reuses the engine through one seam (HarvestSampler)
 *                     |                             | instead of forking its arithmetic.
 */

/**
 * @description Closed-loop energy budgeting for persistent, self-powered nodes: integrate a
 * harvest sampler against a load set and a store, and decide whether the design actually closes.
 * Domain-free by construction — the only environmental coupling is {@link HarvestSampler}.
 * Import from '@/shared/energy' — never deep-import sub-modules directly.
 *
 * @module shared/energy
 */
export {
  DEFAULT_DURATION_HOURS,
  recommendStorageWh,
  simulateEnergyBudget,
  totalDrawW,
  type EnergyBudgetOptions,
  type EnergyBudgetResult,
} from './energy-budget';
export { longestGapHours } from './harvest-gap';
export type {
  EnergyBudgetDesign,
  EnergyBudgetSample,
  EnergyBudgetVerdict,
  HarvestSampler,
  PowerLoad,
  StorageConfig,
} from './energy-types';
