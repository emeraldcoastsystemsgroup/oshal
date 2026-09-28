/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the request-level shapes the /api/location consent, ingest and share services share. LocationRequestError is the one refusal they raise (a stable code plus the HTTP status the router answers with; fixed text that never carries a coordinate, place name or subject); the precision ordering decides whether a change raises precision and so needs the step-up proof; the id and class validators keep malformed input out of every statement. These live in the app layer, beside the routes, and not in the location kernel skill: the skill's barrel is the package-facing contract (ADR-169 D3 "Kernel skill operations"), and consent changes are reachable only through the step-up-gated core routes, never through `uses: location`.
 *
 * @module app/location-request
 */

import { isLocationPrecisionClass, type LocationPrecisionClass } from '@/shared/utils/geo';

/** @description The shape of an id the location store mints (a UUID). */
export const LOCATION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description A location request the service refuses, with a stable code and the HTTP status the
 * /api/location router answers with. The message is fixed text written here.
 */
export class LocationRequestError extends Error {
  /** @description Stable code callers map to an outcome, e.g. 'reporting_off' or 'step_up_required'. */
  readonly code: string;

  /** @description The HTTP status that fits the refusal. */
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'LocationRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @description Precision classes from coarsest to finest. A change to a later entry raises
 * precision, which exposes more and so needs the step-up proof (ADR-169 D3 "precision raise").
 */
export const LOCATION_PRECISION_ORDER: readonly LocationPrecisionClass[] = Object.freeze(['place-only', 'city', 'block', 'exact']);

/**
 * @description Whether moving from one precision class to another raises precision.
 * @param previous - The class in force.
 * @param next - The class asked for.
 * @returns true when `next` is finer than `previous`.
 */
export function raisesLocationPrecision(previous: string, next: string): boolean {
  return LOCATION_PRECISION_ORDER.indexOf(next as LocationPrecisionClass)
    > LOCATION_PRECISION_ORDER.indexOf(previous as LocationPrecisionClass);
}

/**
 * @description Refuse anything that is not a precision class.
 * @param value - A request field.
 * @returns The class.
 * @throws {LocationRequestError} 400 invalid_precision_class.
 */
export function requirePrecisionClass(value: unknown): LocationPrecisionClass {
  if (!isLocationPrecisionClass(value)) {
    throw new LocationRequestError('invalid_precision_class', 400, 'precisionClass must be exact, block, city or place-only.');
  }
  return value;
}

/**
 * @description Refuse anything that is not a location id.
 * @param value - A request field or path parameter.
 * @param code - The refusal code to use.
 * @param label - What the id names, for the message.
 * @returns The id, lower-cased.
 * @throws {LocationRequestError} 400 with `code`.
 */
export function requireLocationId(value: unknown, code = 'invalid_device_id', label = 'deviceId'): string {
  if (typeof value !== 'string' || !LOCATION_ID_SHAPE.test(value)) {
    throw new LocationRequestError(code, 400, `${label} must be an id.`);
  }
  return value.toLowerCase();
}
