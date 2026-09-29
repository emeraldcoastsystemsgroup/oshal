/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6 (D3 "Location enrolment"): the scope of a location credential. A token bound to a location device (oshal_cli_tokens.location_device_id) is admitted on exactly one request, POST /api/location/devices/<its device id>/presence, and refused everywhere else: another device's presence path, every other location route, the worker plane including /api/remote-clients/register, the enrollment handshake and every account route. Pure decisions, no Express and no database, the shape of its sibling decideNodeTokenScope, so the guard spec drives the same function the token-auth middleware does. The path is compared on decoded segments, as the node scope is, so an encoded id, a trailing slash or a repeated separator cannot smuggle a different device past a prefix compare.
 *
 * @module location/services/location-token-scope
 */

/** @description The router base the device ingest lives under (mounted in server.ts). */
export const LOCATION_PLANE_PREFIX = '/api/location';

/** @description The one method a location credential may use. */
export const LOCATION_TOKEN_METHOD = 'POST';

/** @description Why a location credential was admitted, or refused, on a request. */
export type LocationTokenScopeDecision =
  | { allowed: true; reason: 'own-device-presence' }
  | { allowed: false; reason: 'foreign-device' | 'off-plane' | 'method' };

/** @description Input to {@link decideLocationTokenScope}: the binding plus the request. */
export interface LocationTokenScopeInput {
  /** The location device id the token is bound to (oshal_cli_tokens.location_device_id). */
  boundDeviceId: string;
  /** The request method as Express reports it. */
  method: string;
  /** The full request path as Express reports it (req.path), query already stripped. */
  path: string;
}

/**
 * @description Split a path into decoded, non-empty segments. A malformed escape does not throw; it
 * simply fails to match, which fails closed.
 * @param path - The request path.
 * @returns Decoded segments.
 */
function segmentsOf(path: string): string[] {
  return String(path ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * @description The presence path a location credential is confined to.
 * @param deviceId - The bound device.
 * @returns `/api/location/devices/<deviceId>/presence`.
 */
export function locationDevicePresencePath(deviceId: string): string {
  return `${LOCATION_PLANE_PREFIX}/devices/${encodeURIComponent(deviceId)}/presence`;
}

/**
 * @description Decide whether a location credential may authenticate this request (ADR-169 D3).
 * It is admitted only on `POST /api/location/devices/<boundDeviceId>/presence`. Fails closed on a
 * blank binding: a row without a device id is not a location credential and must never be handled here.
 * @param input - The token's bound device id, the request method and path.
 * @returns The decision with its reason (logged on refusal; never a secret).
 */
export function decideLocationTokenScope(input: LocationTokenScopeInput): LocationTokenScopeDecision {
  const bound = String(input.boundDeviceId ?? '').trim();
  if (bound.length === 0) return { allowed: false, reason: 'off-plane' };
  const segments = segmentsOf(input.path);
  const plane = segmentsOf(LOCATION_PLANE_PREFIX);
  const onPlane = segments.length === plane.length + 3
    && plane.every((segment, index) => segments[index] === segment)
    && segments[plane.length] === 'devices'
    && segments[plane.length + 2] === 'presence';
  if (!onPlane) return { allowed: false, reason: 'off-plane' };
  if (segments[plane.length + 1] !== bound) return { allowed: false, reason: 'foreign-device' };
  if (String(input.method ?? '').toUpperCase() !== LOCATION_TOKEN_METHOD) return { allowed: false, reason: 'method' };
  return { allowed: true, reason: 'own-device-presence' };
}
