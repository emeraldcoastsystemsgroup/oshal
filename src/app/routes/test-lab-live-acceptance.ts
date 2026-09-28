/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the signed-in Test Lab adapter for the automated live-acceptance sweep. The cases live once in scripts/lib/live-acceptance-*.js (the host runner scripts/operations/live-acceptance.js drives the same code with the operator token); this file only binds their ports to the running server as the initiating caller: loopback JSON and multipart calls carrying the caller's session cookie, the closed named-statement set on the request-identity pool, the ticket service, and the shared workspace root for fixture-tagged ask workspaces. The headless Chromium and `docker logs` ports exist only on the host, so the commerce and Jarvis-cache cards answer a named gap here before any call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | An `anonymous` port: the same loopback JSON request with no session cookie, so a case can prove a route refuses an unauthenticated caller (the dev-workspace query route must answer 401/403).
 */
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { createChildLogger } from '@/shared/logger';
import type { ScenarioRunContext, State, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-live-acceptance' });

/** The Lab app label every live-acceptance step carries. */
export const LIVE_ACCEPTANCE_APP = 'live-acceptance';
/** Per-call ceiling for one loopback request; each case bounds its own polling. */
const CALL_TIMEOUT_MS = 30_000;

/** One case's result as the shared case modules report it. */
export interface LiveAcceptanceResult {
  caseId: string;
  state: 'pass' | 'fail' | 'degraded' | 'unavailable';
  detail: string;
  evidence: Record<string, unknown>;
  cleanup: { created: number; removed: string[]; kept: string[]; outstanding: string[]; errors: string[] };
}

/** The shape of one shared case module (scripts/lib/live-acceptance-<case>.js). */
export interface LiveAcceptanceCaseModule {
  CASE_ID: string;
  KEY: string;
  TITLE: string;
  NEEDS: readonly string[];
  run(ports: Record<string, unknown>, options?: Record<string, unknown>): Promise<LiveAcceptanceResult>;
}

/** One registry entry (scripts/lib/live-acceptance-cases.js). */
export interface LiveAcceptanceCaseEntry {
  module: LiveAcceptanceCaseModule;
  backlog: string;
  spendsModel: boolean;
  writes: boolean;
}

interface CommonModule {
  fixtureWorkspaceState(root: string, id: string): string;
  removeFixtureWorkspace(root: string, id: string, ownerSub: string): string | null;
  receiptLine(receipt: LiveAcceptanceResult['cleanup']): string;
}

// The cases are plain CommonJS under scripts/lib so the host runner can stage them into a
// container; the image carries them through Dockerfile.oshal's scripts/lib/*.js COPY.
/* eslint-disable @typescript-eslint/no-require-imports */
const registry = require('../../../scripts/lib/live-acceptance-cases.js') as { CASES: LiveAcceptanceCaseEntry[] };
const common = require('../../../scripts/lib/live-acceptance-common.js') as CommonModule;
const statements = require('../../../scripts/lib/live-acceptance-sql.js') as { statementText(name: string): string };
/* eslint-enable @typescript-eslint/no-require-imports */

/** Every registered live-acceptance case, in run order. */
export const LIVE_ACCEPTANCE_CASES: readonly LiveAcceptanceCaseEntry[] = registry.CASES;

/** How a case state shows on a Lab card: a deployment that cannot exercise the claim is a gap. */
const LAB_STATE: Record<LiveAcceptanceResult['state'], State> = { pass: 'pass', fail: 'fail', degraded: 'degraded', unavailable: 'gap' };

/** One loopback reply in the shape the case modules read. */
interface CallResult { status: number; json: Record<string, unknown>; text: string; contentType: string; location: string | null }

/**
 * @description One loopback request to the running server as the initiating signed-in caller.
 * @param base - The server's own loopback base URL (server-derived, never from the request body).
 * @param cookie - The caller's session cookie, forwarded verbatim; null sends no cookie (the anonymous port).
 * @param method - HTTP method.
 * @param route - API path beginning with a slash.
 * @param init - Body and extra headers.
 * @returns The status, parsed JSON (empty object when not JSON), text, content type and redirect target.
 */
async function send(base: string, cookie: string | null, method: string, route: string, init: { body?: string | FormData; headers?: Record<string, string> }): Promise<CallResult> {
  const response = await fetch(`${base}${route}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { ...(init.headers || {}), ...(cookie === null ? {} : { cookie }) }, ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: response.status, json: json && typeof json === 'object' ? json : {}, text: text.slice(0, 65_536),
    contentType: String(response.headers.get('content-type') || ''), location: response.headers.get('location') };
}

/**
 * @description Bind the case ports available inside the server to the initiating caller.
 * @param cookie - The initiating session cookie.
 * @param runtime - Server-derived run context (owner, stores, loopback base).
 * @returns The ports; `anonymous` sends no cookie; `browser` and `logs` are absent on purpose (host-only).
 */
export function labPorts(cookie: string, runtime: ScenarioRunContext): Record<string, unknown> {
  const { ctx } = runtime;
  const base = runtime.apiBaseUrl;
  const root = resolveSharedWorkspaceRoot();
  const jsonInit = (body?: unknown, options: { headers?: Record<string, string> } = {}) => ({
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    ownerSub: runtime.ownerSub,
    origin: base,
    api: (method: string, route: string, body?: unknown, options?: { headers?: Record<string, string> }) => send(base, cookie, method, route, jsonInit(body, options)),
    anonymous: (method: string, route: string, body?: unknown, options?: { headers?: Record<string, string> }) => send(base, null, method, route, jsonInit(body, options)),
    upload: (route: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields || {})) form.append(name, String(value));
      form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
      return send(base, cookie, 'POST', route, { body: form });
    },
    // The Lab step runs inside the caller's own request, whose identity the pool already stamps.
    sql: ctx.pool ? (name: string, params: unknown[]) => ctx.pool.query(statements.statementText(name), params) : undefined,
    tickets: ctx.ticketService ? {
      get: async (id: string) => ctx.ticketService.getTicket(id),
      delete: async (id: string) => { await ctx.ticketService.deleteTicket(id); },
    } : undefined,
    workspace: {
      state: async (id: string) => common.fixtureWorkspaceState(root, id),
      remove: async (id: string) => common.removeFixtureWorkspace(root, id, runtime.ownerSub),
    },
  };
}

/**
 * @description Run one registered live-acceptance case as the Lab's signed-in principal.
 * @param key - The case key (scripts/lib/live-acceptance-cases.js).
 * @param cookie - The initiating session cookie.
 * @param runtime - Server-derived run context.
 * @returns The Lab step result; `output` carries the case id, evidence and cleanup receipt.
 */
export async function runLiveAcceptanceCase(key: string, cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const entry = LIVE_ACCEPTANCE_CASES.find((candidate) => candidate.module.KEY === key);
  const label = entry ? entry.module.TITLE : key;
  if (!entry) return { app: LIVE_ACCEPTANCE_APP, label, state: 'fail', detail: `No live-acceptance case is registered as ${key}.` };
  if (!cookie || !runtime?.ownerSub || !runtime.ctx) {
    return { app: LIVE_ACCEPTANCE_APP, label, state: 'degraded', detail: 'A signed-in session is required; nothing was written.' };
  }
  const started = Date.now();
  const result = await entry.module.run(labPorts(cookie, runtime));
  logger.info({ caseId: result.caseId, state: result.state, durationMs: Date.now() - started }, 'live acceptance case finished');
  return {
    app: LIVE_ACCEPTANCE_APP, label, state: LAB_STATE[result.state] ?? 'fail',
    detail: `${result.detail} Cleanup: ${common.receiptLine(result.cleanup)}.`,
    output: { caseId: result.caseId, evidence: result.evidence, cleanup: result.cleanup },
  };
}
