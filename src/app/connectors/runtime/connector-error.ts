/**
 * ConnectorError — the single, normalized failure shape every connector throws.
 *
 * Today each bespoke client throws a bare `Error` with an ad-hoc message ("spotify 429: ...")
 * and an optional `.status`, so callers (bots, surfaces, the test lab) get 20 different failure
 * shapes. The runtime collapses all provider failures into ONE shape so callers can branch on
 * `retriable` / `status` / `code` consistently and surfaces can render a uniform error.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — part of ADR-065
 *            | (connector runtime). Additive; existing clients keep throwing bare Errors.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/connector-error
 */

/** Coarse, transport-level classification so callers don't string-match messages. */
export type ConnectorErrorCode =
  | 'auth'          // 401/403 — token missing, expired-after-refresh, or insufficient scope
  | 'rate_limited'  // 429 — provider throttled us (retriable, honor Retry-After)
  | 'not_found'     // 404
  | 'bad_request'   // other 4xx — caller's fault, NOT retriable
  | 'server'        // 5xx — provider's fault, retriable
  | 'network'       // fetch threw (DNS/TLS/timeout) — retriable
  | 'unknown';

export interface ConnectorErrorInit {
  provider: string;
  status?: number;
  code: ConnectorErrorCode;
  retriable: boolean;
  message: string;
  bodySnippet?: string;
  attempts?: number;
  cause?: unknown;
}

export class ConnectorError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly code: ConnectorErrorCode;
  readonly retriable: boolean;
  readonly bodySnippet?: string;
  readonly attempts: number;

  constructor(init: ConnectorErrorInit) {
    super(`${init.provider} ${init.status ?? init.code}: ${init.message}`);
    this.name = 'ConnectorError';
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.retriable = init.retriable;
    this.bodySnippet = init.bodySnippet;
    this.attempts = init.attempts ?? 1;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** Classify an HTTP status into a code + retriability (the one place this judgement lives). */
  static fromStatus(provider: string, status: number, bodySnippet: string, attempts: number): ConnectorError {
    let code: ConnectorErrorCode = 'unknown';
    let retriable = false;
    if (status === 401 || status === 403) { code = 'auth'; retriable = false; }
    else if (status === 404) { code = 'not_found'; retriable = false; }
    else if (status === 429) { code = 'rate_limited'; retriable = true; }
    else if (status >= 500) { code = 'server'; retriable = true; }
    else if (status >= 400) { code = 'bad_request'; retriable = false; }
    return new ConnectorError({ provider, status, code, retriable, message: bodySnippet.slice(0, 200) || `HTTP ${status}`, bodySnippet, attempts });
  }

  /** A transport-level failure (fetch threw) — always retriable. */
  static fromNetwork(provider: string, cause: unknown, attempts: number): ConnectorError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ConnectorError({ provider, code: 'network', retriable: true, message, attempts, cause });
  }
}
