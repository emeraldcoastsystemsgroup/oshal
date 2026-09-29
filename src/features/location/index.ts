/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: barrel for the location kernel skill. This slice ships the storage half: the table inventory, the owner-stamped transaction every storage operation runs in, the owner's purge (and a group admin's purge of a group device), the owner's export, the one erase function both account-erasure routes call, and a catalog read of the store's row-level-security posture (the Test Lab card's check). The package-facing reads (currentPlace, distanceBand, placeAt, operationAddress) arrive with L4 and extend this barrel; nothing here returns a coordinate to a model.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: export the package-facing reads (placeAt, currentPlace, distanceBand, operationAddress), their shapes and their two refusals, and the ambient-caller helper they share. placeAt, currentPlace and distanceBand are model-safe (places by reference, a band, "since"); operationAddress is for server code passing an address into a fixed provider operation only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: export locatedDevice (a package's read of whether the ambient caller may see a device's location record, ids only: the drone package scopes its position reads with it) and the location credential's scope decision (decideLocationTokenScope, which the token-auth middleware applies before the account-PAT path). The device ingest and the credential mint stay in the app layer, as the consent services do, so `uses: location` never reaches a device write or a mint.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7: export the two map operations (anchorMap, which records where a map was captured by reference and returns ids only; mapsNear, which answers the maps the caller may read near a point, by reference), their shapes, their bounds and the refusal for an owner whose precision class stores no coordinates.
 *
 * @module location
 */

export {
  LOCATION_ANCHOR_SOURCES,
  LOCATION_MAP_KINDS,
  LOCATION_PERSON_TABLES,
  LOCATION_TABLES,
  LocationForbiddenError,
  LocationInputError,
  LocationNotFoundError,
  LocationPrecisionError,
  LocationPrincipalError,
} from './model/location-types';
export type {
  LocationCurrentPlace,
  LocationEraseResult,
  LocationExport,
  LocationMapAnchorInput,
  LocationMapAnchorResult,
  LocationMapRef,
  LocationOperationAddress,
  LocationPlaceRef,
  LocationPrincipal,
  LocationPurgeResult,
  LocationSubject,
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
export {
  LOCATION_BAND_MAX_AGE_DEFAULT_SEC,
  callerLocationPrincipal,
  currentPlace,
  distanceBand,
  locationBandMaxAgeMs,
  operationAddress,
  placeAt,
} from './services/location-place-reads';
export { LOCATION_LOOKUP_KINDS, locatedDevice } from './services/location-device-reads';
export {
  LOCATION_MAPS_NEAR_DEFAULT_LIMIT,
  LOCATION_MAPS_NEAR_RADIUS_RANGE_M,
  LOCATION_MAP_FOOTPRINT_RANGE_M,
  anchorMap,
  locationMapsNearLimit,
  mapsNear,
} from './services/location-map-anchors';
export type { LocationDeviceRef } from './services/location-device-reads';
export {
  LOCATION_PLANE_PREFIX,
  LOCATION_TOKEN_METHOD,
  decideLocationTokenScope,
  locationDevicePresencePath,
} from './services/location-token-scope';
export type { LocationTokenScopeDecision, LocationTokenScopeInput } from './services/location-token-scope';
