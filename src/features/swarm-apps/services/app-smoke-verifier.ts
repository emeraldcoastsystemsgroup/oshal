/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Execute manifest-declared app smokes over the real HTTP boundary with package-local fixtures and deterministic assertions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | ADR-141: a `kind: group` (no code, no smokes of its own) is verified THROUGH its members via options.resolveMember — every member must be installed, active and pass its own smokes, reported as `<member>/<smoke>`; without a resolver the group fails by name rather than passing empty.
 */

import fs from 'fs';
import path from 'path';
import type {
  SwarmApplicationRecord,
  SwarmAppSmokeDeclaration,
} from '../types';
import { isGroupManifest } from './swarm-app-group';

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Minimal fetch seam used by the real runtime and loopback-HTTP regression tests. */
export type AppSmokeFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Result of one manifest smoke. */
export interface AppSmokeResult {
  name: string;
  path: string;
  status: 'passed' | 'failed' | 'pending';
  durationMs: number;
  httpStatus?: number;
  error?: string;
}

/** Result for one named installed application. */
export interface AppSmokeApplicationResult {
  appName: string;
  status: 'passed' | 'failed' | 'pending';
  smokes: AppSmokeResult[];
  error?: string;
}

/** Aggregate returned to installers; `failedApps` always names the broken package. */
export interface AppSmokeVerificationResult {
  success: boolean;
  failedApps: string[];
  pendingApps: string[];
  apps: AppSmokeApplicationResult[];
}

/** Runtime inputs which never come from a package manifest. */
export interface AppSmokeVerificationOptions {
  apiBaseUrl: string;
  serviceSecret?: string;
  authorization?: string;
  noAi?: boolean;
  preOnboarding?: boolean;
  timeoutMs?: number;
  fetchImpl?: AppSmokeFetch;
  /** ADR-141: resolves a group's member records — a group has no smokes of its own and is verified
   *  THROUGH its members. Absent → a group fails by name (never silently passes). */
  resolveMember?: (name: string) => Promise<SwarmApplicationRecord | null>;
}

/** @description Resolve one RFC 6901 JSON pointer. */
function atJsonPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value };
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** @description Scalar equality with case-insensitive normalization for sentinel strings. */
function rejectedValue(value: unknown, rejected: Array<string | number | boolean | null>): boolean {
  for (const candidate of rejected) {
    if (typeof candidate === 'string') {
      const wanted = candidate.trim().toLowerCase();
      if (wanted === 'empty') {
        if (
          value === null || value === undefined || value === '' ||
          (Array.isArray(value) && value.length === 0) ||
          (typeof value === 'object' && value !== null && Object.keys(value).length === 0)
        ) return true;
      }
      if (typeof value === 'string' && value.trim().toLowerCase() === wanted) return true;
    } else if (Object.is(value, candidate)) {
      return true;
    }
  }
  return false;
}

/** @description Read a previously validated fixture again at execution to close TOCTOU escapes. */
function readFixture(record: SwarmApplicationRecord, fixturePath: string): string {
  const packageDir = fs.realpathSync(path.dirname(record.manifestPath));
  const fixture = fs.realpathSync(path.resolve(packageDir, fixturePath));
  const relative = path.relative(packageDir, fixture);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('body fixture escapes package directory');
  }
  const stat = fs.statSync(fixture);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('body fixture is not a bounded regular file');
  const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8')) as unknown;
  return JSON.stringify(parsed);
}

/** @description Build only the authentication mode explicitly allowed by the manifest. */
function smokeHeaders(
  smoke: SwarmAppSmokeDeclaration,
  options: AppSmokeVerificationOptions,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (smoke.auth === 'service') {
    if (!options.serviceSecret) throw new Error('service-auth smoke requires SWARM_SERVICE_SECRET');
    headers['x-service-secret'] = options.serviceSecret;
  }
  if (smoke.auth === 'pat') {
    if (!/^Bearer\s+oshal_pat_[a-f0-9]{48}$/.test(options.authorization || '')) {
      throw new Error('PAT-auth smoke requires an oshal_pat_ bearer token');
    }
    headers.authorization = options.authorization as string;
  }
  if (smoke.bodyFixture) headers['content-type'] = 'application/json';
  return headers;
}

/** @description Execute one smoke against the actual mounted package route. */
async function executeSmoke(
  record: SwarmApplicationRecord,
  smoke: SwarmAppSmokeDeclaration,
  options: AppSmokeVerificationOptions,
): Promise<AppSmokeResult> {
  if (smoke.requiresAi && options.preOnboarding && !options.noAi) {
    return { name: smoke.name, path: smoke.path, status: 'pending', durationMs: 0 };
  }
  const startedAt = Date.now();
  try {
    const base = new URL(options.apiBaseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('api base must use http or https');
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as AppSmokeFetch);
    const response = await fetchImpl(new URL(smoke.path, base).toString(), {
      method: smoke.method,
      headers: smokeHeaders(smoke, options),
      ...(smoke.bodyFixture ? { body: readFixture(record, smoke.bodyFixture) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'manual',
    });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response exceeds 256 KiB');

    if (smoke.requiresAi && options.noAi) {
      let disabled: unknown;
      try { disabled = JSON.parse(text); } catch { disabled = null; }
      const code = disabled && typeof disabled === 'object'
        ? String((disabled as Record<string, unknown>).code || (disabled as Record<string, unknown>).error || '')
        : '';
      if (response.status !== 503 || code !== 'ai_disabled') {
        throw new Error(`declared no-AI route returned ${response.status}/${code || 'no code'}, expected 503/ai_disabled`);
      }
      return {
        name: smoke.name,
        path: smoke.path,
        status: 'passed',
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
      };
    }

    if (response.status !== smoke.expect.status) {
      throw new Error(`HTTP ${response.status}, expected ${smoke.expect.status}`);
    }
    if (smoke.expect.jsonPointer !== undefined) {
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error('response is not JSON'); }
      const selected = atJsonPointer(json, smoke.expect.jsonPointer);
      if (!selected.found) throw new Error(`JSON pointer ${smoke.expect.jsonPointer || '<root>'} not found`);
      if (rejectedValue(selected.value, smoke.expect.rejectValues ?? [])) {
        throw new Error(`JSON pointer ${smoke.expect.jsonPointer || '<root>'} contains a rejected value`);
      }
    }
    return {
      name: smoke.name,
      path: smoke.path,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      name: smoke.name,
      path: smoke.path,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: (error as Error).message,
    };
  }
}

/**
 * @description ADR-141: a group carries no code, so "is it operational" means "are its members" —
 * every member must be installed, active and pass its OWN smokes; the member smokes are reported
 * under the group prefixed `<member>/<smoke>`. A group with no member resolver fails by name: the
 * CORE-05 rule that a smoke-less package never silently passes holds for groups too.
 * @param requestedName - The group name as requested.
 * @param record - The group's active record.
 * @param options - Verification options (must carry `resolveMember`).
 * @returns The group's aggregate result.
 */
async function verifyGroupThroughMembers(
  requestedName: string,
  record: SwarmApplicationRecord,
  options: AppSmokeVerificationOptions,
): Promise<AppSmokeApplicationResult> {
  if (!options.resolveMember) {
    return { appName: requestedName, status: 'failed', smokes: [], error: 'group members cannot be resolved by this verifier' };
  }
  const smokes: AppSmokeResult[] = [];
  const errors: string[] = [];
  for (const memberName of record.manifest.dependencies?.apps ?? []) {
    const member = await options.resolveMember(memberName);
    if (!member) { errors.push(`member ${memberName} is not installed`); continue; }
    if (member.status !== 'active') { errors.push(`member ${memberName} is inactive`); continue; }
    if (!member.manifest.smoke?.length) { errors.push(`member ${memberName} declares no smoke probes`); continue; }
    for (const smoke of member.manifest.smoke) {
      const result = await executeSmoke(member, smoke, options);
      smokes.push({ ...result, name: `${memberName}/${result.name}` });
    }
  }
  const status = errors.length || smokes.some((s) => s.status === 'failed')
    ? 'failed'
    : smokes.some((s) => s.status === 'pending') ? 'pending' : 'passed';
  return { appName: requestedName, status, smokes, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/**
 * @description Execute every declared smoke for the exact installed app records supplied by the
 * control plane. Missing/inactive/no-smoke packages fail by name; no inferred green state exists.
 * An ADR-141 group is verified through its members (see verifyGroupThroughMembers).
 */
export async function verifyAppSmokes(
  records: Array<{ requestedName: string; record: SwarmApplicationRecord | null }>,
  options: AppSmokeVerificationOptions,
): Promise<AppSmokeVerificationResult> {
  const apps: AppSmokeApplicationResult[] = [];
  for (const { requestedName, record } of records) {
    if (!record) {
      apps.push({ appName: requestedName, status: 'failed', smokes: [], error: 'app is not installed' });
      continue;
    }
    if (record.status !== 'active') {
      apps.push({ appName: requestedName, status: 'failed', smokes: [], error: 'app is inactive' });
      continue;
    }
    if (isGroupManifest(record.manifest)) {
      apps.push(await verifyGroupThroughMembers(requestedName, record, options));
      continue;
    }
    if (!record.manifest.smoke?.length) {
      apps.push({ appName: requestedName, status: 'failed', smokes: [], error: 'manifest declares no smoke probes' });
      continue;
    }
    const smokes: AppSmokeResult[] = [];
    for (const smoke of record.manifest.smoke) smokes.push(await executeSmoke(record, smoke, options));
    const status = smokes.some((smoke) => smoke.status === 'failed')
      ? 'failed'
      : smokes.some((smoke) => smoke.status === 'pending') ? 'pending' : 'passed';
    apps.push({ appName: requestedName, status, smokes });
  }
  const failedApps = apps.filter((app) => app.status === 'failed').map((app) => app.appName);
  const pendingApps = apps.filter((app) => app.status === 'pending').map((app) => app.appName);
  return { success: failedApps.length === 0, failedApps, pendingApps, apps };
}
