/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: the location store's table inventory and the shapes its storage functions exchange. The table lists are the single source the erase, purge and export functions and the /api/me registry exclusion read, so a table added to migration 175 without being added here is caught by the live spec that compares this list with the database.
 *
 * @module location/model/location-types
 */

/**
 * @description The exact person a location operation acts for: the subject and the verified issuer
 * that together key every person row (ADR-169 D3). Both are required; a session without a verified
 * issuer cannot own location rows.
 */
export interface LocationPrincipal {
  /** The authenticated subject. */
  sub: string;
  /** The verified issuer namespace of that subject. */
  principalIssuer: string;
}

/** @description Every table migration 175 creates, in the order a person's rows are erased. */
export const LOCATION_TABLES: readonly string[] = Object.freeze([
  'location_current',
  'location_observations',
  'location_shares',
  'location_guardian_shares',
  'location_member_restrictions',
  'location_devices',
  'location_places',
  'location_settings',
]);

/**
 * @description The tables whose rows can be one person's own (owner_sub + principal_issuer). The
 * restriction and guardian-share tables are tenant rows naming a member and are not in this list:
 * they go with the membership (ADR-169 D3 cascade), never through the person's own delete.
 */
export const LOCATION_PERSON_TABLES: readonly string[] = Object.freeze([
  'location_current',
  'location_observations',
  'location_shares',
  'location_devices',
  'location_places',
  'location_settings',
]);

/** @description Rows removed by an owner's history purge (Q4): history plus the current row. */
export interface LocationPurgeResult {
  /** Observations deleted. */
  observationCount: number;
  /** Current-state rows deleted. */
  currentCount: number;
}

/** @description What the location erase did for one person, counted per table. */
export interface LocationEraseResult {
  /** Rows deleted per location table, keyed by table name. */
  deleted: Record<string, number>;
  /** Location device credentials revoked (oshal_cli_tokens rows the person held). */
  credentialsRevoked: number;
  /** Registered evaluator-state erasers that ran and succeeded. */
  stateErasersRun: number;
  /** Registered evaluator-state erasers that threw (named, so a failure is never silent). */
  stateErasersFailed: string[];
}

/** @description One person's location rows, table by table, as their own export reads them. */
export type LocationExport = Record<string, Array<Record<string, unknown>>>;

/**
 * @description Raised when an operation is asked to act for a principal without a subject or a
 * verified issuer. Location rows are keyed on both, so acting without one would either touch
 * nothing silently or, worse, match another person who shares the subject under a different issuer.
 */
export class LocationPrincipalError extends Error {
  /** @description Stable code for callers that map it to an outcome. */
  readonly code = 'location_principal_required';

  constructor() {
    super('A location operation needs a signed-in subject with a verified issuer.');
    this.name = 'LocationPrincipalError';
  }
}

/** @description Raised when a group-scoped purge is asked for by someone who is not that group's admin. */
export class LocationForbiddenError extends Error {
  /** @description Stable code for callers that map it to an outcome. */
  readonly code = 'location_forbidden';

  constructor() {
    super('Only an admin of the group may do that.');
    this.name = 'LocationForbiddenError';
  }
}
