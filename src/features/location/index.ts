/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: barrel for the location kernel skill. This slice ships the storage half: the table inventory, the owner-stamped transaction every storage operation runs in, the owner's purge (and a group admin's purge of a group device), the owner's export, the one erase function both account-erasure routes call, and a catalog read of the store's row-level-security posture (the Test Lab card's check). The package-facing reads (currentPlace, distanceBand, placeAt, operationAddress) arrive with L4 and extend this barrel; nothing here returns a coordinate to a model.
 *
 * @module location
 */

export {
  LOCATION_PERSON_TABLES,
  LOCATION_TABLES,
  LocationForbiddenError,
  LocationPrincipalError,
} from './model/location-types';
export type {
  LocationEraseResult,
  LocationExport,
  LocationPrincipal,
  LocationPurgeResult,
} from './model/location-types';
export { requireLocationPrincipal, withLocationOwnerSession } from './services/location-owner-session';
export type { LocationDb } from './services/location-owner-session';
export { exportOwnLocationData, purgeGroupDeviceHistory, purgeOwnLocationHistory } from './services/location-history';
export { eraseLocationData, registerLocationStateEraser } from './services/location-erase';
export type { LocationStateEraser } from './services/location-erase';
export {
  LOCATION_FENCE_FUNCTIONS,
  LOCATION_OPERATOR_BYPASS_TOKEN,
  inspectLocationRlsPosture,
  reachableLocationFunctions,
} from './services/location-rls-posture';
export type { LocationCatalogReader, LocationRlsPosture, LocationTablePosture } from './services/location-rls-posture';
