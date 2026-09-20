/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CV-4 regression guard: the handover validator is handed the TICKET id while handovers are written under the WORKSPACE id, so a ticket whose workspace id differs from its ticket id can never pass. Drives the real MultiRoundDispatchService with a REAL RALFHandoverManager rooted at a temp directory — a stubbed manager or a bare SHARED_WORKSPACE_ROOT proves nothing, because the strict path returns true immediately when the manager is absent and never reads the env.
 */

/**
 * Companion to tests/unit/handover-read-uses-workspace-id.spec.ts, which covers the same defect with
 * two cases and a doubled handover manager. Both are kept deliberately: a doubled manager cannot prove
 * the strict path, because validateHandover returns true the moment the manager is absent and never
 * reads the workspace root. These cases drive a real manager, add the relaxed path (which isolates the
 * second call site) and add the negatives that stop the fix degenerating into always-true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MultiRoundDispatchService } from '@/features/swarm-orchestration/services/multi-round-dispatch-service';
import { RALFHandoverManager } from '@/features/swarm-orchestration/services/ralf-handover-manager';
import type { SwarmCyclePolicy } from '@/features/swarm-orchestration/services/swarm-cycle-policy';
import type { MeshCommunicationService } from '@/features/agent-management';

/** A ticket id and a workspace id that are deliberately different — the whole point of CV-4. */
const TICKET_ID = 'ticket-cv4-0000-1111-2222';
const WORKSPACE_ID = 'workspace-cv4-3333-4444-5555';
const AGENT_ID = 'agent-cv4-primary';
/** Phase 7 is absent from PHASE_ROLE_MAP, so it takes the single-round path — one round, no reviewer. */
const PHASE = 7;

/** Long enough to clear the validator's 50-character content floor. */
const HANDOVER_BODY = [
  '# Developer handover',
  '',
  'Implemented the round and recorded what the next agent needs to know.',
  'This body exists only to exceed the validator content floor.',
].join('\n');

const POLICY: SwarmCyclePolicy = {
  maxVerificationAttempts: 1,
  maxBuildRegressions: 1,
  maxDesignRegressions: 1,
  maxWritebackAttempts: 1,
  maxTotalCycles: 1,
  maxRunDurationMs: 1_000,
  verificationRetryDelayMs: 0,
  writebackRetryDelayMs: 0,
  escalationTarget: 'operator',
  escalationSeverity: 'medium',
} as SwarmCyclePolicy;

let workspaceRoot: string;
let previousSharedRoot: string | undefined;

/**
 * @description Write one handover file into the WORKSPACE id's directory, which is where a bot
 * actually writes it and where the validator fails to look before the fix.
 * @param filename - Handover file name, which decides whether the strict or relaxed path matches.
 * @returns Nothing; the file is written for the round under test.
 */
function writeHandoverUnderWorkspaceId(filename: string): void {
  const dir = join(workspaceRoot, WORKSPACE_ID, 'developer-handovers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), HANDOVER_BODY, 'utf8');
}

/**
 * @description Build the service with a real handover manager and inert collaborators, so the
 * only thing under test is which identifier the validator is given.
 * @returns A dispatch service whose handover manager reads the temp workspace root.
 */
function buildService(): MultiRoundDispatchService {
  const meshService = {
    send: async () => undefined,
  } as unknown as MeshCommunicationService;

  return new MultiRoundDispatchService({
    meshService,
    // No work-item repository: awaitRoundOutput returns immediately, so the round does not poll.
    handoverManager: new RALFHandoverManager(workspaceRoot),
    selectAgent: async () => AGENT_ID,
  });
}

/**
 * @description Run one round and report whether the handover was accepted.
 * @returns The public allHandoversPresent flag from the phase result.
 */
async function runRound(): Promise<boolean> {
  const result = await buildService().executePhaseWithRounds(
    'run-cv4', TICKET_ID, PHASE, [], AGENT_ID, POLICY, WORKSPACE_ID,
  );
  return result.allHandoversPresent;
}

describe('CV-4 — handover validation uses the workspace id, not the ticket id', () => {
  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'oshal-cv4-'));
    previousSharedRoot = process.env.SHARED_WORKSPACE_ROOT;
    // The relaxed fallback reads this env var directly; the strict path never does.
    process.env.SHARED_WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    if (previousSharedRoot === undefined) delete process.env.SHARED_WORKSPACE_ROOT;
    else process.env.SHARED_WORKSPACE_ROOT = previousSharedRoot;
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('accepts a handover the agent wrote under the workspace id (strict path)', async () => {
    // Named for this agent, so the strict readAgentHandover match is the path that must succeed.
    writeHandoverUnderWorkspaceId(`${AGENT_ID}_PHASE_${PHASE}_ROUND_1.md`);

    expect(await runRound()).toBe(true);
  });

  it('accepts a handover another agent wrote for the round under the workspace id (relaxed path)', async () => {
    // A different agent id, so the strict filter returns null and only the relaxed
    // filename scan can find it. This isolates the second call site.
    writeHandoverUnderWorkspaceId(`some-other-agent_PHASE_${PHASE}_ROUND_1.md`);

    expect(await runRound()).toBe(true);
  });

  it('still rejects a round with no handover anywhere', async () => {
    // Guards against the fix degenerating into "always true".
    expect(await runRound()).toBe(false);
  });

  it('does not accept a handover filed under the ticket id when the workspace id differs', async () => {
    // The pre-fix location. Writing here must not satisfy a round whose workspace is elsewhere,
    // or the validator would be reading a directory no bot on this ticket writes to.
    const strayDir = join(workspaceRoot, TICKET_ID, 'developer-handovers');
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, `${AGENT_ID}_PHASE_${PHASE}_ROUND_1.md`), HANDOVER_BODY, 'utf8');

    expect(await runRound()).toBe(false);
  });
});
