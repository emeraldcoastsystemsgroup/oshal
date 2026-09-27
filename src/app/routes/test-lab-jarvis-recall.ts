/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the signed-in Test Lab adapter for the Jarvis cross-conversation recall acceptance case. The case itself lives once in scripts/lib/jarvis-recall-acceptance.js (the live proof drives the same code with the operator PAT); this file only binds its ports to the running server: the initiating session cookie for loopback calls, the app's own task and message stores for the seed, the request-identity pool for the residue read, and the shared workspace root for the ask's capture.
 */
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { createChildLogger } from '@/shared/logger';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';
import type { ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-jarvis-recall' });

/** The Lab card label for this step. */
export const JARVIS_RECALL_STEP_LABEL = 'Answers from a different thread of the same user';
const APP = 'jarvis';
/** Per-call ceiling for one loopback request; the answer budget is the case's own poll loop. */
const CALL_TIMEOUT_MS = 20_000;

/** One loopback reply, JSON body parsed (an empty object when the body is not JSON). */
interface CallResult { status: number; json: Record<string, unknown> }

/** The shape of the shared case module this adapter drives. */
export interface JarvisRecallAcceptanceModule {
  CASE_ID: string;
  runJarvisRecallAcceptance(ports: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
    caseId: string; state: 'pass' | 'fail' | 'degraded'; detail: string; evidence: Record<string, unknown>;
  }>;
}

// The case is plain CommonJS under scripts/lib so the live proof can stage it into a container
// that predates this step; the image carries it through Dockerfile.oshal's scripts/lib COPY.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const acceptance = require('../../../scripts/lib/jarvis-recall-acceptance.js') as JarvisRecallAcceptanceModule;

/**
 * @description One loopback call to the running server as the initiating signed-in caller.
 * @param base - The server's own loopback base URL (server-derived, never from the request body).
 * @param cookie - The caller's session cookie, forwarded verbatim.
 * @param method - HTTP method.
 * @param path - API path beginning with a slash.
 * @param body - Optional JSON body.
 * @returns The status and parsed body.
 */
async function call(base: string, cookie: string, method: string, path: string, body?: unknown): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS), redirect: 'manual',
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, json };
}

/**
 * @description Run the recall case as the Lab's signed-in principal. It spends ONE real model turn
 * on the caller's configured Jarvis brain, which is why the card is explicit-only (never part of a
 * run-all). Without a cookie, a verified issuer or a persistent store it writes nothing.
 * @param cookie - The initiating session cookie.
 * @param runtime - Server-derived run context (owner, issuer, stores, loopback base).
 * @param options - Optional budget overrides (answerBudgetMs, settleBudgetMs, pollMs); tests only.
 * @returns The Lab step result; `output` carries the case's evidence summary.
 */
export async function runJarvisCrossThreadRecall(
  cookie: string, runtime?: ScenarioRunContext, options: Record<string, unknown> = {},
): Promise<StepResult> {
  const ctx = runtime?.ctx;
  if (!cookie || !runtime?.issuer || !runtime.ownerSub || !ctx?.pool || !ctx.taskStore || !ctx.messageStore) {
    return { app: APP, label: JARVIS_RECALL_STEP_LABEL, state: 'degraded',
      detail: 'A verified issuer, signed-in session cookie and persistent task store are required; no fixture was created.' };
  }
  const started = Date.now();
  const result = await acceptance.runJarvisRecallAcceptance({
    ownerSub: runtime.ownerSub,
    api: (method: string, path: string, body?: unknown) => call(runtime.apiBaseUrl, cookie, method, path, body),
    taskStore: ctx.taskStore,
    messageStore: ctx.messageStore,
    query: (sql: string, params: unknown[]) => ctx.pool.query(sql, params),
    // The Lab runs inside the caller's own request, whose identity the pool already stamps.
    withOwner: <T>(fn: () => Promise<T>) => fn(),
    agentId: JARVIS_AGENT_ID,
    threadMetadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: runtime.issuer },
    workspaceRoot: resolveSharedWorkspaceRoot(),
  }, options);
  logger.info({ caseId: result.caseId, state: result.state, durationMs: Date.now() - started }, 'jarvis recall acceptance finished');
  return { app: APP, label: JARVIS_RECALL_STEP_LABEL, state: result.state, detail: result.detail, output: result.evidence };
}
