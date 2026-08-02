/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ground slice barrel: the soil thermal wave
 *                     |                             | model + the TEG resistance network + a closed-loop budget
 *                     |                             | for a subterranean thermal-harvesting node. The budget
 *                     |                             | engine itself is @/shared/energy; this slice supplies only
 *                     |                             | the physics that turns a depth pair into watts.
 */

export type { GroundUnitConfig, JunctionPair, PowerLoad, SoilProfile, StorageConfig, TegModuleConfig } from './model/ground-types';
export {
  ANNUAL_PERIOD_S,
  DEFAULT_GEOTHERMAL_GRADIENT_KM,
  DEFAULT_SOIL,
  DIURNAL_PERIOD_S,
  DRY_SAND_SOIL,
  WET_CLAY_SOIL,
  dampingDepthM,
  junctionDeltaTK,
  soilTempC,
} from './services/soil-thermal';
export {
  DEFAULT_GROUND_DURATION_HOURS,
  groundHarvestW,
  longestHarvestGapHours,
  matchedModuleResistanceKW,
  recommendGroundStorageWh,
  simulateGroundBudget,
  tegPowerW,
} from './services/teg-harvester';
