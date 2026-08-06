/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add deterministic controller issuance for 15-30 minute API delegations, bounded by the parent dispatch and persisted before release.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep invalid route normalization inside structured entry/failure logging without emitting the raw request target.
 */

import { createChildLogger } from '@/shared/logger';
import { normalizePrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import {
  createRecordedDelegationTokenIssuer,
  type RecordedDelegationToken,
  type RecordedDelegationTokenIssuer,
} from '@/shared/security/delegation-token';
import {
  delegationIssuerFromEnvironment,
  workloadDelegationAudienceFromEnvironment,
} from '@/shared/security/delegation-http-policy';
import type { WorkloadDelegationStore } from './workload-delegation-types';
import {
  canonicalDelegationMethod,
  canonicalDelegationPath,
  resolveWorkloadDelegationRoute,
} from './workload-delegation-route-policy';
import { requireWorkloadId } from './workload-credential';

const logger = createChildLogger({ module: 'workload-delegation-issuer' });
const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 1_800;

type DelegationEnvironment = Readonly<Record<string, string | undefined>>;

/** @description Trusted controller input for one exact user-data API call. */
export interface IssueWorkloadDelegationInput {
  workloadId: string;
  userSub: string;
  principalIssuer: string;
  ticketId?: string;
  runId?: string;
  method: string;
  path: string;
  body?: unknown;
  /** Parent dispatch expiry; delegated authority is refused if fewer than 15 minutes remain. */
  dispatchExpiresAt: Date;
}

/** @description Construction seams for deterministic issuer tests and controller composition. */
export interface WorkloadDelegationIssuerOptions {
  env?: DelegationEnvironment;
  tokenIssuer?: RecordedDelegationTokenIssuer;
  nowEpochSeconds?: () => number;
}

/** @description Controller service that signs only code-owned route scopes and records them first. */
export class WorkloadDelegationIssuerService {
  private readonly env: DelegationEnvironment;
  private readonly tokenIssuer: RecordedDelegationTokenIssuer;
  private readonly nowEpochSeconds: () => number;

  /**
   * @description Creates the deterministic issuer over one durable store and controller key.
   * @param store - PostgreSQL authority used to authorize the workload and record the grant.
   * @param options - Optional environment, issuer, and clock seams.
   */
  constructor(
    private readonly store: WorkloadDelegationStore,
    options: WorkloadDelegationIssuerOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
    const ttlSeconds = readWorkloadTtl(this.env.OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS);
    this.tokenIssuer = options.tokenIssuer ?? createRecordedDelegationTokenIssuer({
      env: { ...this.env, OSHAL_DELEGATION_TTL_SECONDS: String(ttlSeconds) },
      nowEpochSeconds: this.nowEpochSeconds,
    });
  }

  /**
   * @description Issues a route-bound single-use token only after code-owned metadata selects the
   * scope and the active workload is allowed to hold it. The durable row is inserted before the
   * token is returned, so a database outage cannot create untracked authority.
   * @param input - Trusted user, dispatch, workload, exact route, body, and parent expiry.
   * @returns Signed token receipt whose claims match the persisted row byte-for-byte.
   */
  async issue(input: IssueWorkloadDelegationInput): Promise<RecordedDelegationToken> {
    const startedAt = Date.now();
    let route: ReturnType<typeof normalizeIssueRoute> | null = null;
    logger.info({ operation: 'issue' }, 'Workload delegation issuance entered');
    try {
      route = normalizeIssueRoute(input);
      const result = await this.issueAuthorized(input, route.method, route.path, route.requiredScopes);
      logger.info({ workloadId: input.workloadId, method: route.method, route: route.routeTemplate, durationMs: Date.now() - startedAt }, 'Workload delegation issuance exited');
      return result;
    } catch (error) {
      logger.error({ err: error, method: route?.method, route: route?.routeTemplate, durationMs: Date.now() - startedAt }, 'Workload delegation issuance failed');
      throw error;
    }
  }

  private async issueAuthorized(
    input: IssueWorkloadDelegationInput,
    method: string,
    path: string,
    scopes: readonly string[],
  ): Promise<RecordedDelegationToken> {
    const workloadId = requireWorkloadId(input.workloadId);
    const now = readNow(this.nowEpochSeconds);
    const dispatchExpiry = dispatchExpiryEpoch(input.dispatchExpiresAt, now);
    if (!(await this.store.canIssueForWorkload(workloadId, scopes, new Date(now * 1_000)))) {
      throw new Error('Workload is not authorized for delegated route scope');
    }
    const receipt = this.tokenIssuer.issue({
      iss: delegationIssuerFromEnvironment(this.env),
      aud: workloadDelegationAudienceFromEnvironment(this.env),
      sub: requireUserSub(input.userSub),
      principal_iss: requirePrincipalIssuer(input.principalIssuer),
      azp: workloadId,
      task_id: dispatchId(input),
      method,
      path,
      body_sha256: delegationRequestBodySha256(input.body ?? null),
      scope: [...scopes],
    }, { expiresAtEpochSeconds: dispatchExpiry });
    await this.store.recordDelegation({
      claims: receipt.claims,
      ticketId: input.ticketId,
      runId: input.runId,
    });
    return receipt;
  }
}

function normalizeIssueRoute(input: IssueWorkloadDelegationInput) {
  const method = canonicalDelegationMethod(input.method);
  const path = canonicalDelegationPath(input.path);
  const policy = resolveWorkloadDelegationRoute(method, path);
  if (!policy) throw new Error('Route is not eligible for workload delegation');
  return { ...policy, path };
}

function readWorkloadTtl(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_SECONDS;
  if (!/^\d+$/.test(raw.trim())) throw new Error('OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS must be an integer');
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    throw new Error('Workload delegation TTL must be between 900 and 1800 seconds');
  }
  return value;
}

function readNow(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Workload delegation clock is invalid');
  return value;
}

function dispatchExpiryEpoch(value: Date, now: number): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Parent dispatch expiry is invalid');
  }
  const expiry = Math.floor(value.getTime() / 1_000);
  if (expiry < now + MIN_TTL_SECONDS) {
    throw new Error('Parent dispatch has less than 15 minutes of authority remaining');
  }
  return expiry;
}

function dispatchId(input: IssueWorkloadDelegationInput): string {
  const values = [input.ticketId, input.runId]
    .filter((value): value is string => typeof value === 'string');
  if (values.length !== 1 || values[0].length === 0 || values[0].length > 256) {
    throw new Error('Exactly one bounded ticketId or runId is required');
  }
  return values[0];
}

function requireUserSub(value: string): string {
  const subject = optionalExactUserSubject(value, 'delegation user subject');
  if (!subject) throw new Error('Delegation user subject is invalid');
  return subject;
}

function requirePrincipalIssuer(value: string): string {
  const issuer = normalizePrincipalIssuer(value);
  if (!issuer) throw new Error('Delegation principal issuer is invalid');
  return issuer;
}
