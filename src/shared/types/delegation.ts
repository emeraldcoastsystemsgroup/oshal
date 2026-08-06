/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Defined the versioned, task-bound delegation token wire contract used between the controller and one authorized bot agent.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed the delegation header to EdDSA and made the delegated user subject an exact verifier binding so bot-side public material cannot mint or ambiguously consume controller authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound the authenticated principal issuer separately from the controller token issuer so identical subject strings from different identity providers cannot collide during delegated execution.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Document jti as the active shared single-use replay key now enforced by bot-node Redis authorization.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Bind the complete canonical HTTP request body digest so task identity cannot authorize mutated execution inputs.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Bind every delegation to the exact HTTP method and canonical route path so authority cannot move between endpoints that happen to accept the same body and scope.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Advance the wire version for the required method/path claim schema so rolling deployments reject old-shape tokens explicitly.
 */

/** @description The only delegation token version accepted by this implementation. */
export const DELEGATION_TOKEN_VERSION = 2 as const;

/** @description The protected header carried by every oshal delegation token. */
export interface DelegationTokenHeader {
  /** Ed25519 EdDSA is fixed so an attacker cannot negotiate another algorithm. */
  alg: 'EdDSA';
  /** A private media type prevents this token from being confused with an OIDC JWT. */
  typ: 'OSHAL-DLG';
  /** Selects one configured key without trying every rotation key. */
  kid: string;
  /** Version-gates future claim or validation changes. */
  v: typeof DELEGATION_TOKEN_VERSION;
}

/** @description The complete signed authority delegated for one controller task. */
export interface DelegationTokenClaims {
  /** Controller identity that minted the token. */
  iss: string;
  /** Exact bot-node or controller-API audience allowed to consume the token. */
  aud: string;
  /** Authenticated user identity whose authority is being delegated. */
  sub: string;
  /** Verified identity-provider or platform namespace that authenticated the subject. */
  principal_iss: string;
  /** Exact agent or registered workload identity receiving the authority. */
  azp: string;
  /** Exact dispatch task, ticket, or run protected from cross-dispatch replay. */
  task_id: string;
  /** Exact uppercase HTTP method authorized by this single-use delegation. */
  method: string;
  /** Exact canonical request pathname authorized by this single-use delegation. */
  path: string;
  /** SHA-256 of the complete canonical JSON execution request body. */
  body_sha256: string;
  /** Complete, least-privilege capability set granted to the task. */
  scope: string[];
  /** Unix time when the controller issued the token. */
  iat: number;
  /** Unix time before which the token is not valid. */
  nbf: number;
  /** Unix time at or after which the token is expired. */
  exp: number;
  /** Per-issue nonce atomically consumed by the bot-side shared Redis replay ledger. */
  jti: string;
}

/** @description Caller-supplied authority from which issue time and nonce claims are derived. */
export type DelegationTokenGrant = Pick<
  DelegationTokenClaims,
  | 'iss'
  | 'aud'
  | 'sub'
  | 'principal_iss'
  | 'azp'
  | 'task_id'
  | 'method'
  | 'path'
  | 'body_sha256'
  | 'scope'
>;

/**
 * @description Route bindings that can be checked before durable workload/delegation records
 * establish the signed subject, workload, and dispatch identifiers.
 */
export type DelegationRouteExpectations = Pick<
  DelegationTokenExpectations,
  'iss' | 'aud' | 'method' | 'path' | 'body_sha256' | 'scope'
>;

/**
 * @description Expected dispatch bindings that a verifier must provide explicitly.
 * Omitting any of these checks would turn signature validation into ambient authority.
 */
export interface DelegationTokenExpectations {
  /** Expected controller issuer. */
  iss: string;
  /** Expected local bot-node audience. */
  aud: string;
  /** Agent handling the current dispatch. */
  azp: string;
  /** Task handling the current dispatch. */
  task_id: string;
  /** Exact uppercase HTTP method handling the current request. */
  method: string;
  /** Exact canonical pathname handling the current request. */
  path: string;
  /** Exact canonical request-body SHA-256 protected by the token. */
  body_sha256: string;
  /** Exact capability set required by the current dispatch. */
  scope: readonly string[];
  /** Exact authenticated user identity carried by the current dispatch. */
  sub: string;
  /** Exact verified namespace that authenticated the current dispatch subject. */
  principal_iss: string;
}
