/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verification's test runner over the signed hop: the `workspace-tests/run` deterministic intent goes to its fixed owner (test-engineer's node) as the ticket's owner with its persisted verified issuer, through the same client and route as build execution, with no model turn and no provider config push. The node answers the run as JSON; a refusal, a transport failure or an unreadable answer is a run that did not happen (`runner-unreachable`), never a pass. The run is recorded on the child ticket's metadata (`verificationTests`) so the cockpit and the live case can read it.
 */

import { createChildLogger } from '@/shared/logger';
import type { BotNodeClient } from '@/features/agent-management';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import type { WorkspaceTestRun, WorkspaceTestRunRequest, WorkspaceTestRunner } from './workspace-test-run';

const logger = createChildLogger({ module: 'node-workspace-test-runner' });

/** The intent the node parses (bot-node-provider-intent.ts); the workspace folder id is added per run. */
export const WORKSPACE_TESTS_INTENT = { schemaVersion: 1, kind: 'workspace-tests', operation: 'run' } as const;

/** @description What the runner needs. */
export interface NodeWorkspaceTestRunnerDeps {
  botNodeClient: Pick<BotNodeClient, 'execute'>;
  /** The node the run goes to: the intent's fixed owner. */
  agentId: string;
  /** Reads the child ticket's owner and metadata, so the run is made as the owner with its issuer. */
  readTicket: (ticketId: string) => Promise<{ ownerSub?: string | null; metadata?: Record<string, unknown> | null } | null>;
  /** Records the run on the child ticket; a failure to record never changes the verdict. */
  recordRun?: (ticketId: string, run: WorkspaceTestRun) => Promise<void>;
}

/**
 * @description Creates the runner verification calls for code work.
 * @param deps - The client, the target node and the ticket reader/recorder.
 * @returns The runner.
 */
export function createNodeWorkspaceTestRunner(deps: NodeWorkspaceTestRunnerDeps): WorkspaceTestRunner {
  return async (request) => {
    const run = await runOnNode(deps, request);
    if (deps.recordRun) {
      await deps.recordRun(request.ticketId, run).catch((err) => logger.error({ err, ticketId: request.ticketId }, 'Workspace test run could not be recorded on the ticket'));
    }
    return run;
  };
}

/**
 * @description One run on the node, as the ticket's owner.
 * @param deps - Runner deps.
 * @param request - The run.
 * @returns The run the node reported, or a not-run naming why it could not be made.
 */
async function runOnNode(deps: NodeWorkspaceTestRunnerDeps, request: WorkspaceTestRunRequest): Promise<WorkspaceTestRun> {
  const startedAt = Date.now();
  const ticket = await deps.readTicket(request.ticketId).catch(() => null);
  const ownerSub = typeof ticket?.ownerSub === 'string' && ticket.ownerSub.trim() ? ticket.ownerSub.trim() : undefined;
  if (!ownerSub) return notRun('no-owner: the ticket has no owner to run as', startedAt);
  try {
    const result = await deps.botNodeClient.execute(deps.agentId, {
      text: 'workspace-tests/run',
      taskId: request.ticketId,
      workspaceFolderId: request.workspaceTaskId,
      agentId: deps.agentId,
      providerIntent: { ...WORKSPACE_TESTS_INTENT, workspaceFolderId: request.workspaceTaskId },
      userSub: ownerSub,
      principalIssuer: readOwnerPrincipalIssuer(ticket?.metadata ?? undefined) ?? undefined,
    });
    if (!result.success) return notRun(`runner-unreachable: ${result.error ?? 'the node reported a failed run'}`, startedAt);
    const run = parseRun(result.response);
    if (!run) return notRun('runner-unreachable: the node answer was not a test run', startedAt);
    logger.info({ ticketId: request.ticketId, agentId: deps.agentId, ran: run.ran, exitCode: run.exitCode, passed: run.passed, failed: run.failed, reason: run.reason }, 'Workspace test run answered by the node');
    return run;
  } catch (err) {
    logger.error({ err, ticketId: request.ticketId, agentId: deps.agentId }, 'Workspace test run over the signed hop failed');
    return notRun(`runner-unreachable: ${err instanceof Error ? err.message : String(err)}`, startedAt);
  }
}

/**
 * @description The run the node serialized into its completion, when it is one.
 * @param response - The node's response text.
 * @returns The run, or undefined when the text is not a run.
 */
function parseRun(response: unknown): WorkspaceTestRun | undefined {
  if (typeof response !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(response); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.ran !== 'boolean' || typeof value.passed !== 'number' || typeof value.failed !== 'number' || !Array.isArray(value.failedTests)) return undefined;
  return {
    ran: value.ran,
    command: typeof value.command === 'string' ? value.command : null,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    passed: value.passed,
    failed: value.failed,
    failedTests: value.failedTests.filter((name): name is string => typeof name === 'string'),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    outputTail: typeof value.outputTail === 'string' ? value.outputTail : '',
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
  };
}

function notRun(reason: string, startedAt: number): WorkspaceTestRun {
  return { ran: false, command: null, exitCode: null, passed: 0, failed: 0, failedTests: [], reason, outputTail: '', durationMs: Date.now() - startedAt };
}
