/**
 * Connector write-action executor + audit trail (connector-writes tier).
 *
 * The one pipeline every declared connector write goes through:
 *   validate params (JSON-Schema subset, before ANY credential/HTTP work)
 *     -> approval gate (riskLevel medium/high or approvalRequired => explicit confirm:true,
 *        the same fail-closed risky-write rail as /api/email/send et al: HTTP 428)
 *     -> LAZY credential resolution (broker-only, resolveConnectorActionCreds — a malformed or
 *        unconfirmed request never triggers a broker read / token refresh; resolver failures are
 *        audited, not 500'd)
 *     -> fail-closed pre-write 'attempt' audit row (audit trail down => the write is REFUSED, 503)
 *     -> real HTTP call via the shared ConnectorClient (retries OFF for non-idempotent writes)
 *     -> terminal audit row (success/error; best-effort post-write, auditRecorded:false on gap).
 *
 * Credentials are the CALLER's brokered credential only (resolveConnectorActionCreds) — never raw
 * secrets, never the spec file, and never an operator env key: a write must execute under the
 * caller's own provider identity. A user with no stored connection gets a clean audited 401
 * not_connected instead of fake output or a borrowed credential.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — write-capable connector action executor: validate -> gate -> execute -> audit, with params_hash (sha256) and per-attempt connector_action_audit rows (migration 083).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: creds now resolve LAZILY after validation+confirm gate via an injected broker-only resolver (resolver throw/not-connected are audited 401s, not unaudited 500s), and executed writes are fail-closed on the audit trail — an 'attempt' row must persist BEFORE the provider call or the write is refused with 503 audit_unavailable.
 *
 * @module connectors/runtime/action-executor
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { confirmationRequiredPayload, hasExplicitWriteConfirmation } from '@/shared/security/explicit-write-confirmation';
import { connectorActionRequiresApproval, validateActionParams, type SpecAction } from './action-params';
import { ConnectorError } from './connector-error';
import { buildClientFromSpec, type BuildSpecOptions, type ConnectorSpec } from './spec';
import type { SpecRouteResult } from './spec-routes';
import type { RequestOptions } from './types';

const logger = createChildLogger({ module: 'connector-action-executor' });

/**
 * @description Outcome of one action attempt, persisted verbatim in connector_action_audit.status.
 * 'attempt' is the pre-write row for executed writes (fail-closed: it must land before the
 * provider call); every other value is terminal. 'not_connected' = the caller has no brokered
 * credential — writes never fall back to operator env keys.
 */
export type ConnectorActionAuditStatus =
  | 'attempt'
  | 'success'
  | 'error'
  | 'not_connected'
  | 'confirmation_required'
  | 'invalid_params'
  | 'unknown_action';

/**
 * @description One audit row: who attempted which write, with which (hashed, never raw) params, and
 * how it ended. params_hash keeps the trail reviewable without persisting payloads that may contain
 * message bodies or PII.
 */
export interface ConnectorActionAuditRow {
  userSub: string;
  connectorId: string;
  action: string;
  paramsHash: string;
  riskLevel?: string;
  status: ConnectorActionAuditStatus;
  httpStatus?: number;
  error?: string;
}

/** @description Minimal pg surface the audit recorder needs — trivially mockable in unit tests. */
export interface ConnectorActionAuditPool {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

/** Runtime DDL mirror of scripts/migrations/083-connector-action-audit.sql (table + indexes only;
 *  the append-only triggers are migration-owned). Keeps a fresh local boot working pre-migration. */
const AUDIT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS connector_action_audit (
  audit_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub     TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  risk_level   TEXT,
  status       TEXT NOT NULL,
  http_status  INTEGER,
  error        TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const ensuredPools = new WeakSet<object>();

/**
 * @description Computes the sha256 hex digest of the canonical (key-sorted) JSON encoding of the
 * params, so equal params always hash equal regardless of property order and the audit trail never
 * stores raw payload content.
 * @param params The caller-supplied action params.
 * @returns 64-char lowercase hex digest.
 */
export function hashConnectorActionParams(params: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableStringify(params ?? {})).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @description Persists one audit row (lazily ensuring the table on first use so a pre-migration
 * local boot still records). Never throws: a failed audit insert is logged at ERROR and surfaced to
 * the caller via the boolean so the route can flag `auditRecorded:false` instead of masking the
 * write outcome behind an audit-infra failure.
 * @param pool pg pool (or mock) with a query method.
 * @param row The attempt+outcome to record.
 * @returns true when the row was written.
 */
export async function recordConnectorActionAudit(pool: ConnectorActionAuditPool, row: ConnectorActionAuditRow): Promise<boolean> {
  try {
    if (!ensuredPools.has(pool)) {
      await pool.query(AUDIT_TABLE_DDL);
      ensuredPools.add(pool);
    }
    await pool.query(
      `INSERT INTO connector_action_audit (user_sub, connector_id, action, params_hash, risk_level, status, http_status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.userSub, row.connectorId, row.action, row.paramsHash, row.riskLevel ?? null, row.status, row.httpStatus ?? null, row.error ?? null],
    );
    return true;
  } catch (err) {
    logger.error({ err, stack: err instanceof Error ? err.stack : undefined, connectorId: row.connectorId, action: row.action, status: row.status }, 'connector action audit insert failed');
    return false;
  }
}

/** @description Everything one action attempt needs; creds come from the broker, never the spec. */
export interface RunConnectorActionDeps {
  pool: ConnectorActionAuditPool;
  spec: ConnectorSpec;
  /**
   * LAZY broker-only credential resolution for THIS caller (wrap resolveConnectorActionCreds).
   * Called only after params validation and the confirm gate pass, so garbage/unconfirmed
   * requests never trigger a broker read or token refresh. Return null = caller not connected
   * (audited 401); a throw = credential failure (audited 401, never an unaudited 500).
   */
  resolveCreds: () => Promise<BuildSpecOptions | null>;
  userSub: string;
  actionName: string;
  params: Record<string, unknown>;
  /** The raw request body, checked for the explicit-write confirm signal (confirm: true). */
  requestBody: unknown;
  /** Test injection point; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * @description Executes one declared connector write action end-to-end: unknown-action 404,
 * params-schema 400, approval gate 428 (fail-closed, no HTTP attempted), lazy broker-only
 * credential resolution (audited 401 on not-connected / resolver failure), a fail-closed
 * pre-write 'attempt' audit row (503 refusal when the trail is unavailable), then the real
 * provider call with a terminal audit row.
 * @param deps Pool + spec + lazy creds resolver + caller identity + params.
 * @returns HTTP status + JSON body ready for the route to send.
 */
export async function runConnectorAction(deps: RunConnectorActionDeps): Promise<SpecRouteResult> {
  const paramsHash = hashConnectorActionParams(deps.params);
  const action = (deps.spec.actions ?? []).find((a) => a.name === deps.actionName);
  if (!action) {
    return finish(deps, undefined, paramsHash, 'unknown_action', {
      status: 404,
      body: { ok: false, code: 'unknown_action', error: `${deps.spec.provider}: unknown action '${deps.actionName}'` },
    });
  }
  const violations = validateActionParams(action.paramsSchema, deps.params);
  if (violations.length > 0) {
    return finish(deps, action, paramsHash, 'invalid_params', {
      status: 400,
      body: { ok: false, code: 'invalid_params', error: violations.join('; ') },
    });
  }
  if (connectorActionRequiresApproval(action) && !hasExplicitWriteConfirmation(deps.requestBody)) {
    const payload = confirmationRequiredPayload('connector-write', `${deps.spec.provider}.${action.name}`);
    return finish(deps, action, paramsHash, 'confirmation_required', {
      status: 428,
      body: { ok: false, ...payload } as SpecRouteResult['body'],
    });
  }
  const resolved = await resolveActionCreds(deps, action, paramsHash);
  if ('refusal' in resolved) return resolved.refusal;
  return executeAuditedWrite(deps, action, paramsHash, resolved.creds);
}

/**
 * @description Resolves the caller's brokered credential LAZILY — only after validation and the
 * confirm gate have passed — and turns every failure mode into an AUDITED 401 instead of an
 * unaudited route-level 500: a resolver throw (e.g. revoked refresh token) audits as 'error', a
 * null (no stored connection) audits as 'not_connected'. Writes never fall back to operator env
 * keys, so there is deliberately no shared-credential path here.
 * @param deps The action attempt deps (resolveCreds + audit pool).
 * @param action The declared action (for the audit risk level).
 * @param paramsHash Canonical params hash for the audit row.
 * @returns The resolved creds, or the audited refusal response to send.
 */
async function resolveActionCreds(
  deps: RunConnectorActionDeps,
  action: SpecAction,
  paramsHash: string,
): Promise<{ creds: BuildSpecOptions } | { refusal: SpecRouteResult }> {
  let creds: BuildSpecOptions | null;
  try {
    creds = await deps.resolveCreds();
  } catch (err) {
    logger.error({ err, stack: err instanceof Error ? err.stack : undefined, provider: deps.spec.provider, action: action.name }, 'connector action credential resolution failed');
    const msg = err instanceof Error ? err.message : String(err);
    return {
      refusal: await finish(deps, action, paramsHash, 'error', {
        status: 401,
        body: { ok: false, code: 'auth', error: `${deps.spec.provider}: credential resolution failed — ${msg}` },
      }),
    };
  }
  if (creds === null) {
    return {
      refusal: await finish(deps, action, paramsHash, 'not_connected', {
        status: 401,
        body: { ok: false, code: 'not_connected', error: `${deps.spec.provider}: not connected — connector writes use only the caller's own brokered credential (never a shared operator key)` },
      }),
    };
  }
  return { creds };
}

/**
 * @description Fail-closed audited execution: the 'attempt' row must persist BEFORE the provider
 * call — if the audit trail is unavailable the write is REFUSED (503 audit_unavailable, no
 * provider traffic), because a provider mutation with zero persistent record is worse than a
 * refused one. The terminal row is then necessarily best-effort (the write already happened);
 * auditRecorded:false flags that gap without masking the write outcome.
 * @param deps The action attempt deps.
 * @param action The declared action.
 * @param paramsHash Canonical params hash for the audit rows.
 * @param creds The caller's broker-resolved credentials.
 * @returns HTTP status + JSON body ready for the route to send.
 */
async function executeAuditedWrite(
  deps: RunConnectorActionDeps,
  action: SpecAction,
  paramsHash: string,
  creds: BuildSpecOptions,
): Promise<SpecRouteResult> {
  const attemptRecorded = await recordConnectorActionAudit(deps.pool, {
    userSub: deps.userSub,
    connectorId: deps.spec.provider,
    action: deps.actionName,
    paramsHash,
    riskLevel: action.riskLevel,
    status: 'attempt',
  });
  if (!attemptRecorded) {
    return {
      status: 503,
      body: { ok: false, code: 'audit_unavailable', error: `${deps.spec.provider}.${action.name}: audit trail unavailable — write refused (fail-closed)` },
    };
  }
  try {
    const { data, httpStatus } = await performConnectorActionHttp(deps.spec, action, deps.params, creds, deps.fetchImpl);
    return finish(deps, action, paramsHash, 'success', { status: 200, body: { ok: true, data } }, httpStatus);
  } catch (err) {
    logger.error({ err, stack: err instanceof Error ? err.stack : undefined, provider: deps.spec.provider, action: action.name }, 'connector action execution failed');
    const mapped = mapActionError(err);
    return finish(deps, action, paramsHash, 'error', mapped, mapped.providerStatus, mapped.body.error);
  }
}

/** Record the audit row for a terminal outcome and pass the HTTP result through. */
async function finish(
  deps: RunConnectorActionDeps,
  action: SpecAction | undefined,
  paramsHash: string,
  status: ConnectorActionAuditStatus,
  result: SpecRouteResult,
  httpStatus?: number,
  error?: string,
): Promise<SpecRouteResult> {
  const recorded = await recordConnectorActionAudit(deps.pool, {
    userSub: deps.userSub,
    connectorId: deps.spec.provider,
    action: deps.actionName,
    paramsHash,
    riskLevel: action?.riskLevel,
    status,
    httpStatus,
    error: error ?? (result.body.ok ? undefined : result.body.error),
  });
  if (!recorded) {
    (result.body as Record<string, unknown>).auditRecorded = false;
  }
  return result;
}

/** Render the urlTemplate from params; params not consumed by the path become body (POST/PUT/PATCH) or query (DELETE). */
export function splitConnectorActionInputs(action: SpecAction, params: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
  const placeholders = new Set(Array.from(action.urlTemplate.matchAll(/\{(\w+)\}/g), (m) => m[1]));
  const path = action.urlTemplate.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(params[k] ?? '')));
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!placeholders.has(k) && v !== undefined) rest[k] = v;
  }
  return { path, rest };
}

/** The real provider call: shared ConnectorClient, retries OFF (writes are not idempotent), 204-tolerant. */
async function performConnectorActionHttp(
  spec: ConnectorSpec,
  action: SpecAction,
  params: Record<string, unknown>,
  creds: BuildSpecOptions,
  fetchImpl?: typeof fetch,
): Promise<{ data: unknown; httpStatus?: number }> {
  let lastStatus: number | undefined;
  const built = buildClientFromSpec(spec, {
    ...creds,
    fetchImpl: fetchImpl ?? creds.fetchImpl,
    onCall: (m) => { lastStatus = m.status; creds.onCall?.(m); },
  });
  const { path, rest } = splitConnectorActionInputs(action, params);
  const opts: RequestOptions = { method: action.method, retry: { maxRetries: 0 }, emptyOk: [204] };
  if (action.method === 'DELETE') {
    if (Object.keys(rest).length > 0) {
      opts.query = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === null ? undefined : String(v)]));
    }
  } else if (Object.keys(rest).length > 0) {
    opts.body = rest;
  }
  const data = await built.client.request(path, opts);
  return { data, httpStatus: lastStatus };
}

/** Map a thrown execution error to route status + body (ConnectorError carries provider status/code). */
function mapActionError(err: unknown): SpecRouteResult & { providerStatus?: number } {
  if (err instanceof ConnectorError) {
    const byCode: Record<string, number> = { bad_request: 400, auth: 401, not_found: 404, rate_limited: 429 };
    const status = typeof err.status === 'number' && err.status >= 400 ? err.status : byCode[err.code] ?? 502;
    return { status, providerStatus: err.status, body: { ok: false, error: err.message, code: err.code } };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 502, providerStatus: undefined, body: { ok: false, error: msg } };
}
