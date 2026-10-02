/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the controller-side runner (node-workspace-test-runner.ts) over a recording bot-node client: the request is the workspace-tests/run intent to the fixed owner, as the ticket's owner with its persisted issuer, with no model and no provider config push; the node's JSON answer is the run; a refusal, a thrown transport error or an unreadable answer is runner-unreachable, never a pass; an ownerless ticket is not run; the run is recorded on the ticket and a failing recorder changes nothing.
 */

import { describe, expect, it } from 'vitest';
import { createNodeWorkspaceTestRunner, WORKSPACE_TESTS_INTENT } from '../../src/features/swarm-orchestration/services/node-workspace-test-runner';
import type { WorkspaceTestRun } from '../../src/features/swarm-orchestration/services/workspace-test-run';

const TICKET = '11111111-2222-4333-8444-555555555555';
const ROOT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const NODE = 'a0000000-0000-0000-0000-000000000005';
const OWNER = '100000000000000000001';
const run: WorkspaceTestRun = { ran: true, command: 'npm test', exitCode: 0, passed: 4, failed: 0, failedTests: [], outputTail: 'Tests  4 passed (4)', durationMs: 1200 };

function client(answer: () => Promise<{ success: boolean; response?: unknown; error?: string }>) {
  const calls: Array<{ agentId: string; request: Record<string, unknown> }> = [];
  return { calls, execute: async (agentId: string, request: Record<string, unknown>) => { calls.push({ agentId, request }); return answer() as never; } };
}

const readTicket = async () => ({ ownerSub: OWNER, metadata: { ownerPrincipalIssuer: 'https://accounts.google.com' } });

describe('the runner over the signed hop', () => {
  it('sends the intent to the fixed owner as the ticket owner, with no model and no config push, and returns the node run', async () => {
    const c = client(async () => ({ success: true, response: JSON.stringify(run) }));
    const recorded: Array<[string, WorkspaceTestRun]> = [];
    const runner = createNodeWorkspaceTestRunner({ botNodeClient: c as never, agentId: NODE, readTicket, recordRun: async (id, r) => { recorded.push([id, r]); } });
    const result = await runner({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: 'a0000000-0000-0000-0000-000000000002' });
    expect(result).toEqual(run);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.agentId).toBe(NODE);
    expect(c.calls[0]!.request).toMatchObject({ text: 'workspace-tests/run', taskId: TICKET, workspaceFolderId: ROOT, agentId: NODE, userSub: OWNER, providerIntent: { ...WORKSPACE_TESTS_INTENT, workspaceFolderId: ROOT } });
    expect(c.calls[0]!.request.agenticMode).toBeUndefined();
    expect(c.calls[0]!.request.providerConfigRequired).toBeUndefined();
    expect(c.calls[0]!.request.creds).toBeUndefined();
    expect(recorded).toEqual([[TICKET, run]]);
  });

  it('a refusal, a transport error or an unreadable answer is runner-unreachable, never a pass', async () => {
    const refused = createNodeWorkspaceTestRunner({ botNodeClient: client(async () => ({ success: false, error: 'delegation token rejected' })) as never, agentId: NODE, readTicket });
    expect(await refused({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: NODE })).toMatchObject({ ran: false, reason: 'runner-unreachable: delegation token rejected' });
    const thrown = createNodeWorkspaceTestRunner({ botNodeClient: client(async () => { throw new Error('ECONNREFUSED'); }) as never, agentId: NODE, readTicket });
    expect(await thrown({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: NODE })).toMatchObject({ ran: false, reason: 'runner-unreachable: ECONNREFUSED' });
    const garbage = createNodeWorkspaceTestRunner({ botNodeClient: client(async () => ({ success: true, response: 'Task completed successfully.' })) as never, agentId: NODE, readTicket });
    expect((await garbage({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: NODE })).reason).toBe('runner-unreachable: the node answer was not a test run');
  });

  it('an ownerless ticket is not run and the node is never called', async () => {
    const c = client(async () => ({ success: true, response: JSON.stringify(run) }));
    const runner = createNodeWorkspaceTestRunner({ botNodeClient: c as never, agentId: NODE, readTicket: async () => ({ ownerSub: null }) });
    expect((await runner({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: NODE })).reason).toMatch(/^no-owner/);
    expect(c.calls).toHaveLength(0);
  });

  it('a recorder that fails changes nothing about the verdict', async () => {
    const runner = createNodeWorkspaceTestRunner({ botNodeClient: client(async () => ({ success: true, response: JSON.stringify(run) })) as never, agentId: NODE, readTicket, recordRun: async () => { throw new Error('db down'); } });
    expect(await runner({ ticketId: TICKET, workspaceTaskId: ROOT, agentId: NODE })).toEqual(run);
  });
});
