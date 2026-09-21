/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-20 done-when (2), in its option-4 form. The operator ACCEPTED the shared read-write mount for this single-operator box, with per-ticket runtime assignment as the control, so the owed proof inverts: it demonstrates that a shell pointed at ticket B CAN read ticket A, rather than that it cannot. An accepted risk that nobody has demonstrated is an assumed risk, and the two reversal triggers the decision names - a second person with tickets, or an installed package running its own bot - only mean something if the exposure is a measured fact. It drives the REAL ToolExecutorService handleExecuteCommand, which is the path that actually runs the shell (the service is constructed in the CONTROLLER, not on the bot-nodes, which is the note the entry leaves for whoever builds this). It deliberately does NOT assert the containers share a mount: compose-workspace-mount-posture.spec.ts proves that against the resolved compose, and these two halves together are the claim.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';

const WORKSPACE_ENV_KEYS = [
  'OSHAL_WORKSPACE_ROOT', 'SHARED_WORKSPACE_ROOT', 'CLINE_SHARED_WORKSPACE_ROOT',
  'CLINE_WORKSPACE_ROOT', 'WORKSPACE_ROOT', 'WORKSPACE_DIR',
] as const;

const MARKER = 'ticket-a-private-deliverable-contents';
let saved: Record<string, string | undefined> = {};
let root = '';

beforeEach(() => {
  saved = {};
  for (const key of WORKSPACE_ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  // One shared root with two sibling ticket directories. That IS the deployed shape: forty
  // containers mount the same volume at the same path, so the difference between "two containers"
  // and "one process" is the mount, which the compose posture spec proves separately.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-ckr20-'));
  process.env.OSHAL_WORKSPACE_ROOT = root;
  fs.mkdirSync(path.join(root, 'ticket-a', 'deliverables'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ticket-b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ticket-a', 'deliverables', 'report.md'), MARKER, 'utf8');
});

afterEach(() => {
  for (const key of WORKSPACE_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * The real service with no workspace service, so ensureWorkspacePath uses the flat <root>/<taskId>
 * layout ADR-060's revert left in place. Only the stream manager is doubled: it broadcasts tool
 * lifecycle events to a websocket, which is not the boundary under test and cannot run here.
 */
function executor(): ToolExecutorService {
  return new ToolExecutorService({
    streamManager: { broadcastToolExecution: () => { /* no websocket in a unit spec */ } },
  } as never);
}

/** Run a tool through the real dispatch, exactly as an agentic turn does. */
async function runTool(service: ToolExecutorService, taskId: string, name: string, input: Record<string, unknown>) {
  return (service as unknown as {
    executeTool(taskId: string, name: string, input: Record<string, unknown>): Promise<string>;
  }).executeTool(taskId, name, input);
}

describe('CKR-20 — the accepted exposure, demonstrated rather than assumed', () => {
  it('self-check: the service really rooted itself at the temp root, not somewhere else', () => {
    const service = executor();
    const resolved = (service as unknown as { workspaceRoot: string }).workspaceRoot;
    expect(resolved.split(path.sep).join('/')).toBe(root.split(path.sep).join('/'));
  });

  it('a shell pointed at ticket B READS ticket A — this is the accepted risk, in one line', async () => {
    // ADR-060 already states the consequence: a directory layout on a shared read-write mount is
    // attribution, not enforcement. This is that sentence as an executable fact.
    const output = await runTool(executor(), 'ticket-b', 'execute_command', {
      command: process.platform === 'win32'
        ? 'type ..\\ticket-a\\deliverables\\report.md'
        : 'cat ../ticket-a/deliverables/report.md',
    });
    expect(output, 'the shell could NOT traverse — the decision record is now wrong, not the code')
      .toContain(MARKER);
  });

  it('the TypeScript file tool cannot do the same thing — the two are not equivalent', async () => {
    // The distinction the decision rests on: the file tools ARE contained, the shell is not. If
    // this case ever goes red the containment guard has regressed and the posture is worse than
    // the entry records, which is a different finding from the one being accepted.
    await expect(runTool(executor(), 'ticket-b', 'read_file', {
      path: '../ticket-a/deliverables/report.md',
    })).rejects.toThrow();
  });

  it('runtime assignment IS the control: the shell starts in the ticket it was given', async () => {
    // The operator's model, stated as a test: a bot is pointed at one ticket's directory and that
    // is where it begins. Reaching a sibling requires going somewhere it was not pointed, which is
    // what "prompt injection or a shell" means in the decision.
    const output = await runTool(executor(), 'ticket-b', 'execute_command', {
      command: process.platform === 'win32' ? 'cd' : 'pwd',
    });
    expect(output).toContain('ticket-b');
    expect(output, 'the shell started in a sibling ticket, which would be a worse defect')
      .not.toContain('ticket-a');
  });

  it('the reversal triggers are about who owns the neighbour, not about whether reach exists', async () => {
    // Trigger 1 is "a second person has tickets on the same box". Nothing in the path consults an
    // owner, so a second owner's directory is reachable on exactly the same terms as the operator's
    // own. Pinning that here is what makes the trigger a fact rather than a prediction.
    fs.mkdirSync(path.join(root, 'ticket-c-other-owner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ticket-c-other-owner', 'notes.md'), 'someone else', 'utf8');
    const output = await runTool(executor(), 'ticket-b', 'execute_command', {
      command: process.platform === 'win32'
        ? 'type ..\\ticket-c-other-owner\\notes.md'
        : 'cat ../ticket-c-other-owner/notes.md',
    });
    expect(output).toContain('someone else');
  });
});
