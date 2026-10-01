/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the signed-in Test Lab adapter for the automated live-acceptance sweep. The cases live once in scripts/lib/live-acceptance-*.js (the host runner scripts/operations/live-acceptance.js drives the same code with the operator token); this file only binds their ports to the running server as the initiating caller: loopback JSON and multipart calls carrying the caller's session cookie, the closed named-statement set on the request-identity pool, the ticket service, and the shared workspace root for fixture-tagged ask workspaces. The headless Chromium and `docker logs` ports exist only on the host, so the commerce and Jarvis-cache cards answer a named gap here before any call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | An `anonymous` port: the same loopback JSON request with no session cookie, so a case can prove a route refuses an unauthenticated caller (the dev-workspace query route must answer 401/403).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Every case now runs with an empty runner environment (`env: {}`). The case modules read runner inputs such as OSHAL_VERIFY_DEV_NOTES_PROBE from process.env on the host, but inside the api that is the api's environment, and no compose file forwards any OSHAL_VERIFY_* variable to the api. The dev-workspace card used to fall back to it and told operators to set a variable the api never receives. Now it reports the handover ask as host-runner-only, naming the command.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Every loopback reply also carries `byteLength` and `sha256` of its raw body (text decoded from the same bytes), so a case can prove a binary route served exact bytes, and a `files` port answers whether a NAMED probe's file (live-acceptance-common.js FILE_PROBES, never a path) exists in this server's process. Both serve the vids-publish case: the anonymous public read must equal the uploaded MP4, and cleanup must leave no MP4 on disk.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The same two additions as the host runner, for the create-region-edit card: every reply carries its raw body as `bytes` (the case decodes the PNGs Create serves), and `upload` names its file part `file.field` when the case gives one (Create's upload route reads exactly one part, `image`), `file` otherwise. The card never receives the host runner's `--allow-paid` consent, so on a paid image provider it answers a gap naming that command.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | A `forge` port for the Bot Forge edit-in-place card, the same closed fixture-pack set the host runner reaches through its container helper (live-acceptance-common.js forgePackWrite/State/Remove): the tagged pack is written into the signed-in caller's own packs directory under this server's workspace root, and the personas the deploy writes are read and removed under this process's working directory.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | The Lab's `files` port gains `dir`: a named directory probe's listing under this server's shared workspace root, for the tickets-in-tickets case.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | LiveAcceptanceCaseModule gains the optional REGRESSION_TESTS list a case module may export.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | The Lab's named statements run as the owner WITHOUT operator rights, the way the host runner's container helper runs them, so row-level security scopes them the same from both entry points. The Lab caller is an operator, and the request identity it ran under stamped is_operator on, which admitted every row to the statements' own predicates.
 */
import { createHash } from 'node:crypto';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
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
  /** Specs that guard the seams the case crosses live; its Lab card lists them as regression tests. */
  REGRESSION_TESTS?: ReadonlyArray<{ level: 'unit' | 'integration' | 'browser'; path: string }>;
  run(ports: Record<string, unknown>, options?: Record<string, unknown>): Promise<LiveAcceptanceResult>;
}

/** One registry entry (scripts/lib/live-acceptance-cases.js). */
export interface LiveAcceptanceCaseEntry {
  module: LiveAcceptanceCaseModule;
  backlog: string;
  spendsModel: boolean;
  writes: boolean;
}

/** Parents of the fixture pack that its first write created, so removal may drop them when empty. */
interface ForgePrune { ownerDir?: boolean; packsRoot?: boolean }

interface CommonModule {
  fixtureWorkspaceState(root: string, id: string): string;
  removeFixtureWorkspace(root: string, id: string, ownerSub: string): string | null;
  fileProbeState(name: string, id: string): 'present' | 'absent';
  dirProbeListing(name: string, id: string, root: string): { path: string; exists: boolean; files: string[]; truncated: boolean };
  receiptLine(receipt: LiveAcceptanceResult['cleanup']): string;
  forgePackWrite(root: string, sub: string, tag: string, revision: number): { files: string[]; createdOwnerDir: boolean; createdPacksRoot: boolean };
  forgePackState(root: string, appRoot: string, sub: string, tag: string): Record<string, unknown>;
  forgePackRemove(root: string, appRoot: string, sub: string, tag: string, prune?: ForgePrune): string | null;
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

/**
 * The options every Lab card passes its case. The case modules read runner inputs (the dev-workspace
 * probe words, OSHAL_VERIFY_DEV_*_PROBE) from the `env` option, then from process.env. On the host,
 * process.env is the host runner's own environment. Here it would be the api's, which compose never
 * gives an OSHAL_VERIFY_* variable. An empty `env` makes a case that needs such an input report it as a
 * host-runner step instead of reading a variable that cannot be set here.
 */
const LAB_CASE_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({ env: Object.freeze({}) });

/** How a case state shows on a Lab card: a deployment that cannot exercise the claim is a gap. */
const LAB_STATE: Record<LiveAcceptanceResult['state'], State> = { pass: 'pass', fail: 'fail', degraded: 'degraded', unavailable: 'gap' };

/** One loopback reply in the shape the case modules read; `bytes` is the raw body, and the digest and length are of it. */
interface CallResult { status: number; json: Record<string, unknown>; text: string; contentType: string; location: string | null; bytes: Buffer; byteLength: number; sha256: string }

/**
 * @description One loopback request to the running server as the initiating signed-in caller.
 * @param base - The server's own loopback base URL (server-derived, never from the request body).
 * @param cookie - The caller's session cookie, forwarded verbatim; null sends no cookie (the anonymous port).
 * @param method - HTTP method.
 * @param route - API path beginning with a slash.
 * @param init - Body and extra headers.
 * @returns The status, parsed JSON (empty object when not JSON), text, content type, redirect target, and the raw body with its byte length and sha256.
 */
async function send(base: string, cookie: string | null, method: string, route: string, init: { body?: string | FormData; headers?: Record<string, string> }): Promise<CallResult> {
  const response = await fetch(`${base}${route}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { ...(init.headers || {}), ...(cookie === null ? {} : { cookie }) }, ...(init.body === undefined ? {} : { body: init.body }),
  });
  const raw = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const text = new TextDecoder().decode(raw);
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: response.status, json: json && typeof json === 'object' ? json : {}, text: text.slice(0, 65_536),
    contentType: String(response.headers.get('content-type') || ''), location: response.headers.get('location'),
    bytes: raw, byteLength: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
}

/**
 * @description Bind the case ports available inside the server to the initiating caller.
 * @param cookie - The initiating session cookie.
 * @param runtime - Server-derived run context (owner, stores, loopback base).
 * @returns The ports; `anonymous` sends no cookie; `files` answers named probes only; `forge` writes, reads and removes only the tagged fixture pack; `browser` and `logs` are absent on purpose (host-only).
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
    upload: (route: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer; field?: string }) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields || {})) form.append(name, String(value));
      form.append(file.field || 'file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
      return send(base, cookie, 'POST', route, { body: form });
    },
    // Named statements run as the owner without operator rights (the container helper's identity),
    // so row-level security scopes them the same as on the host, whoever started the Lab run.
    sql: ctx.pool
      ? (name: string, params: unknown[]) => runWithRequestIdentity({ sub: runtime.ownerSub, isOperator: false },
        () => ctx.pool.query(statements.statementText(name), params))
      : undefined,
    tickets: ctx.ticketService ? {
      get: async (id: string) => ctx.ticketService.getTicket(id),
      delete: async (id: string) => { await ctx.ticketService.deleteTicket(id); },
    } : undefined,
    workspace: {
      state: async (id: string) => common.fixtureWorkspaceState(root, id),
      remove: async (id: string) => common.removeFixtureWorkspace(root, id, runtime.ownerSub),
    },
    // Named probes only: the case sends a probe name and an id the probe validates, never a path.
    files: {
      state: async (name: string, id: string) => common.fileProbeState(name, id),
      dir: async (name: string, id: string) => common.dirProbeListing(name, id, root),
    },
    // The Bot Forge fixture pack, for the signed-in caller: this server's workspace root and its
    // working directory, where the deploy route writes personas. A tag and a revision, never a path.
    forge: {
      write: async (tag: string, revision: number) => common.forgePackWrite(root, runtime.ownerSub, tag, revision),
      state: async (tag: string) => common.forgePackState(root, process.cwd(), runtime.ownerSub, tag),
      remove: async (tag: string, prune?: ForgePrune) => common.forgePackRemove(root, process.cwd(), runtime.ownerSub, tag, prune ?? {}),
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
  const result = await entry.module.run(labPorts(cookie, runtime), LAB_CASE_OPTIONS);
  logger.info({ caseId: result.caseId, state: result.state, durationMs: Date.now() - started }, 'live acceptance case finished');
  return {
    app: LIVE_ACCEPTANCE_APP, label, state: LAB_STATE[result.state] ?? 'fail',
    detail: `${result.detail} Cleanup: ${common.receiptLine(result.cleanup)}.`,
    output: { caseId: result.caseId, evidence: result.evidence, cleanup: result.cleanup },
  };
}
