/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — marine slice barrel: tidal harmonic
 *                     |                             | current model + closed-loop power budget for a
 *                     |                             | persistent current-harvesting node.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Unchanged surface after the @/shared/energy extraction — the
 *                     |                             | budget engine moved out from under these names, deliberately
 *                     |                             | without touching one of them. That this list did not move is
 *                     |                             | the evidence the refactor was behaviour-preserving.
 */

export type {
  MarineUnitConfig,
  PowerBudgetSample,
  PowerBudgetVerdict,
  PowerLoad,
  StorageConfig,
  TidalConstituent,
  TidalSiteConfig,
  TurbineConfig,
} from './model/marine-types';
export {
  MODERATE_INLET_SITE,
  SINUSOID_MEAN_CUBE_FACTOR,
  STANDARD_CONSTITUENT_PERIODS_H,
  STRONG_CHANNEL_SITE,
  constituent,
  currentSpeedAt,
  longestSlackHours,
  peakSpeedMs,
} from './services/tidal-current';
export {
  BETZ_LIMIT,
  DEFAULT_DURATION_HOURS,
  SEAWATER_DENSITY_KGM3,
  recommendStorageWh,
  simulatePowerBudget,
  totalDrawW,
  turbinePowerW,
  type PowerBudgetOptions,
  type PowerBudgetResult,
} from './services/power-budget';
