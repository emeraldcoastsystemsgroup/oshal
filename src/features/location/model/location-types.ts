/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: the location store's table inventory and the shapes its storage functions exchange. The table lists are the single source the erase, purge and export functions and the /api/me registry exclusion read, so a table added to migration 175 without being added here is caught by the live spec that compares this list with the database.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the shapes of the package-facing reads (placeAt, currentPlace, distanceBand, operationAddress) and their two refusals. A place is returned by reference (id, name, label); only operationAddress carries an address or a centre, and it is for server code that passes them into a fixed provider operation or the owner's own page, never a prompt. LocationInputError and LocationNotFoundError carry fixed text, never a coordinate, a place name or a subject.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: migration 177's five tables join the inventory (rules, rule state, the fire ledger, share presence, restricted invitations), so the erase, the purge, the export, the /api/me discovery exclusion and the live table-list check all see them. Rules, rule state, fires and share presence can be a person's own rows; restricted invitations are tenant rows naming the invited account. The owner's purge also counts the evaluation history it removed (rule state, share presence and fires, which are history under Q4).
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
  'location_rule_state',
  'location_share_presence',
  'location_rule_fires',
  'location_shares',
  'location_guardian_shares',
  'location_member_restrictions',
  'location_restricted_invites',
  'location_rules',
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
  'location_rule_state',
  'location_share_presence',
  'location_rule_fires',
  'location_shares',
  'location_rules',
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
  /** Evaluation history deleted by the owner's own purge: rule state, share presence and fire rows (L5). */
  evaluationCount?: number;
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

/** @description A place by reference: never its geometry or its address (ADR-169 D3 model-safe reads). */
export interface LocationPlaceRef {
  /** The place id. */
  placeId: string;
  /** The owner's name for it. */
  name: string;
  /** home, work, grocery or other. */
  label: string;
}

/** @description Whose position a read is about: the caller themself, or a device the caller may read. */
export type LocationSubject = 'self' | { deviceId: string };

/**
 * @description What currentPlace answers. `basis` says where the answer comes from: the subject's
 * latest fix (`observed`), a stationary device's assigned place (`assigned`), or nothing (`none`).
 */
export interface LocationCurrentPlace {
  /** The place the subject is at, or null when it is at no saved place or unknown. */
  place: LocationPlaceRef | null;
  /** When the subject arrived there (observed) or the place was assigned (assigned); ISO time. */
  since: string | null;
  /** Seconds since the latest fix was received; null for an assigned place or no fix. */
  ageSeconds: number | null;
  /** observed, assigned or none. */
  basis: 'observed' | 'assigned' | 'none';
}

/** @description What operationAddress answers: for a fixed-server provider operation only, never a prompt. */
export interface LocationOperationAddress {
  /** The place id. */
  placeId: string;
  /** The owner-typed address, or null when none is on file. */
  address: string | null;
  /** The place's centre. */
  center: { lat: number; lon: number };
  /** The place's IANA time zone, or null. */
  timezone: string | null;
}

/** @description Raised for malformed input to a location read: a bad point, subject or id. */
export class LocationInputError extends Error {
  /** @description Stable code for callers that map it to an outcome. */
  readonly code = 'location_invalid_input';

  constructor(message: string) {
    super(message);
    this.name = 'LocationInputError';
  }
}

/** @description Raised when a place or device does not exist or the caller may not read it (the two are not told apart). */
export class LocationNotFoundError extends Error {
  /** @description Stable code for callers that map it to an outcome. */
  readonly code = 'location_not_found';

  constructor(what: 'place' | 'device') {
    super(what === 'place' ? 'No such place of yours or your groups.' : 'No such device of yours or your groups.');
    this.name = 'LocationNotFoundError';
  }
}
