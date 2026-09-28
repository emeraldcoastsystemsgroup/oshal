/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2 (D6 "Deletion and takeout"): the location store in the /api/me registry. One curated exporter, bound to the caller's subject AND verified issuer, whose export is the person's own location rows (plus any restriction or guardian share naming them) and whose delete is eraseLocationData, the same function DELETE /api/privacy/me calls. It leads the registry and its tables are kept out of discovery, so the credential revocation runs before any device row goes and nothing is exported twice. A session without a verified issuer is reported as a failed location store, never as an empty success, because location rows are keyed on the issuer and deleting by subject alone could reach another person.
 *
 * @module app/routes/location-data-lifecycle
 */

import type { DataExporter, PgLike } from '@/features/data-lifecycle';
import {
  LOCATION_TABLES,
  LocationPrincipalError,
  eraseLocationData,
  exportOwnLocationData,
  type LocationDb,
  type LocationPrincipal,
} from '@/features/location';

/** @description The registry key of the location store in the /api/me export and delete outcomes. */
export const LOCATION_STORE = 'location';

/** @description The tables the location exporter owns; discovery must skip every one of them. */
export const LOCATION_COVERED_TABLES: readonly string[] = LOCATION_TABLES;

/**
 * @description The caller as the location store needs them. The issuer is whatever the verified
 * authentication rail established, or null when it established none.
 */
export interface LocationCaller {
  /** The authenticated subject. */
  sub: string;
  /** The verified issuer, or null. */
  principalIssuer: string | null;
}

/**
 * @description Bind a registry call's subject to the caller the exporter was built for.
 * @param caller - The caller.
 * @param userSub - The subject the registry passed.
 * @returns The full principal.
 * @throws {Error} When the registry asks for a different subject.
 * @throws {LocationPrincipalError} When the caller has no verified issuer.
 */
function principalFor(caller: LocationCaller, userSub: string): LocationPrincipal {
  if (userSub !== caller.sub) throw new Error('The location store serves only the signed-in caller.');
  if (!caller.principalIssuer) throw new LocationPrincipalError();
  return { sub: caller.sub, principalIssuer: caller.principalIssuer };
}

/**
 * @description Build the location store's exporter for one request.
 * @param pool - The app's (GUC-wrapped) pool; it must also offer connect() for the owner transaction.
 * @param caller - The authenticated caller's subject and verified issuer.
 * @returns A deletable DataExporter whose delete is the location erase.
 */
export function buildLocationExporter(pool: PgLike & LocationDb, caller: LocationCaller): DataExporter {
  return {
    store: LOCATION_STORE,
    describe: 'Your location settings, devices, places, position history, current position and member shares, '
      + 'plus any restriction or guardian share that names you (ADR-169). Deleting revokes your location device '
      + 'credentials, deletes every location row you own and clears in-memory location state about you; '
      + 'restrictions and guardian shares go with your group memberships.',
    deletable: true,
    async exportRows(userSub: string): Promise<unknown[]> {
      const byTable = await exportOwnLocationData(pool, principalFor(caller, userSub));
      return Object.entries(byTable).flatMap(([table, rows]) => rows.map((row) => ({ table, ...row })));
    },
    async deleteRows(userSub: string): Promise<number> {
      const result = await eraseLocationData(pool, principalFor(caller, userSub));
      if (result.stateErasersFailed.length) {
        throw new Error(`Location rows were erased, but these state erasers failed: ${result.stateErasersFailed.join(', ')}`);
      }
      return Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
    },
  };
}
