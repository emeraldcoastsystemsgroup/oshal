/**
 * Fixed, owner-scoped RingCentral call-log read for trusted application packages.
 *
 * Mirrors the Outlook mail reader seam exactly: the CRM package receives a FUNCTION on its
 * AppContext, calls it with the acting user's sub, and gets back bounded, normalized call
 * summaries. The RingCentral access token is resolved and spent entirely inside this module —
 * it never reaches package code, a route response, or a log line.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial reader (screen-pop v2, call history): GET /restapi/v1.0/account/~/extension/~/call-log (view=Simple) for the caller's own connection, normalized to {id, direction, result, counterpart number/name, startedAt, durationSeconds}. Statuses distinguish not_connected / reconnect_required / missing_permission (the app needs ReadCallLog added + a reconnect) / unavailable. Per-user 60s cooldown cache because call-log sits in RingCentral's Heavy rate group.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getValidAccessToken } from './connector-account-operations';
import { accessibleConnections } from './connector-tenancy';

const logger = createChildLogger({ module: 'ringcentral-call-log' });

const MAX_RESULTS = 250;
const MAX_SINCE_DAYS = 90;
const COOLDOWN_MS = 60_000;

/** @description Read outcome. missing_permission = the RingCentral app lacks ReadCallLog. */
export type RingcentralCallLogStatus =
  'connected' | 'not_connected' | 'reconnect_required' | 'missing_permission' | 'unavailable';

/** @description One normalized call — the only fields that leave this module. */
export interface RingcentralCallSummary {
  id: string;
  direction: 'Inbound' | 'Outbound';
  /** RingCentral result label, e.g. Accepted, Missed, Voicemail, Call connected. */
  result: string;
  counterpartNumber: string;
  counterpartName?: string;
  startedAt: string;
  durationSeconds: number;
}

/** @description Reader input: the acting user and an optional bounded window. */
export interface RingcentralCallLogInput {
  userSub: string;
  sinceDays?: number;
  limit?: number;
}

/** @description Reader result: status plus zero or more normalized calls. */
export interface RingcentralCallLogResult {
  status: RingcentralCallLogStatus;
  calls: RingcentralCallSummary[];
}

/** @description The fixed operation type packages receive on AppContext. */
export type RingcentralCallLogReader = (input: RingcentralCallLogInput) => Promise<RingcentralCallLogResult>;

/** @description Injectable seams for boundary tests; production callers pass nothing. */
export interface RingcentralCallLogDependencies {
  getAccessToken?: typeof getValidAccessToken;
  listConnections?: typeof accessibleConnections;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** @description RingCentral API host (devtest sandbox selectable via env). @returns Base URL. */
function rcBase(): string {
  return (process.env.RINGCENTRAL_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
}

/**
 * @description Normalize one raw call-log record to the bounded summary. Fail-quiet: a record
 * missing its id or start time is dropped rather than guessed at. The counterpart is the OTHER
 * party — `from` on an inbound call, `to` on an outbound one.
 * @param raw - one record from the call-log response
 * @returns the summary, or null when the record is unusable
 */
export function normalizeCallRecord(raw: unknown): RingcentralCallSummary | null {
  const rec = raw as Record<string, any>;
  if (!rec || typeof rec !== 'object' || !rec.id || !rec.startTime) return null;
  const direction = rec.direction === 'Outbound' ? 'Outbound' : rec.direction === 'Inbound' ? 'Inbound' : null;
  if (!direction) return null;
  const party = direction === 'Inbound' ? rec.from : rec.to;
  const number = String(party?.phoneNumber || party?.extensionNumber || '').trim();
  return {
    id: String(rec.id),
    direction,
    result: String(rec.result || '').slice(0, 60),
    counterpartNumber: number.slice(0, 40),
    ...(party?.name ? { counterpartName: String(party.name).slice(0, 120) } : {}),
    startedAt: String(rec.startTime),
    durationSeconds: Number.isFinite(Number(rec.duration)) ? Number(rec.duration) : 0,
  };
}

/**
 * @description Build the fixed call-log read operation exposed to trusted application packages.
 * Live reads only — persistence, matching, and display policy belong to the package that owns
 * the domain. A 60-second per-user cooldown returns the previous result rather than re-hitting
 * RingCentral's Heavy rate group.
 * @param pool - application database pool (connection + token resolution)
 * @param dependencies - injectable seams for boundary tests
 * @returns the reader function stored on AppContext
 */
export function createRingcentralCallLogReader(
  pool: Pool,
  dependencies: RingcentralCallLogDependencies = {},
): RingcentralCallLogReader {
  const getAccessToken = dependencies.getAccessToken ?? getValidAccessToken;
  const listConnections = dependencies.listConnections ?? accessibleConnections;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const cooldown = new Map<string, { at: number; result: RingcentralCallLogResult }>();

  return async (input: RingcentralCallLogInput): Promise<RingcentralCallLogResult> => {
    const userSub = String(input?.userSub || '').slice(0, 512);
    if (!userSub) return { status: 'not_connected', calls: [] };
    const cached = cooldown.get(userSub);
    if (cached && now() - cached.at < COOLDOWN_MS) return cached.result;

    const rows = await listConnections(pool, userSub, 'ringcentral');
    if (!rows.length) return { status: 'not_connected', calls: [] };

    let token: string | null;
    try {
      token = await getAccessToken(pool, userSub, 'ringcentral');
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      return { status: /^refresh\s+(400|401|403)\b/i.test(message) ? 'reconnect_required' : 'unavailable', calls: [] };
    }
    if (!token) return { status: 'reconnect_required', calls: [] };

    const sinceDays = Math.min(Math.max(Number(input.sinceDays) || 30, 1), MAX_SINCE_DAYS);
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), MAX_RESULTS);
    const dateFrom = new Date(now() - sinceDays * 86_400_000).toISOString();
    const url = `${rcBase()}/restapi/v1.0/account/~/extension/~/call-log`
      + `?view=Simple&perPage=${limit}&dateFrom=${encodeURIComponent(dateFrom)}`;
    let result: RingcentralCallLogResult;
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (response.status === 401) result = { status: 'reconnect_required', calls: [] };
      else if (response.status === 403) result = { status: 'missing_permission', calls: [] };
      else if (!response.ok) result = { status: 'unavailable', calls: [] };
      else {
        const payload = await response.json() as { records?: unknown[] };
        const calls = (Array.isArray(payload.records) ? payload.records : [])
          .map(normalizeCallRecord)
          .filter((c): c is RingcentralCallSummary => c !== null);
        result = { status: 'connected', calls };
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ringcentral call-log read failed');
      result = { status: 'unavailable', calls: [] };
    }
    cooldown.set(userSub, { at: now(), result });
    return result;
  };
}
