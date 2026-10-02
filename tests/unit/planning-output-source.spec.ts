/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the in-process plan being read from memory (planning-output-source.ts). Drives the real PlanningRoundOrchestrator and the real TicketDecompositionService over a real temp workspace root, with the multi-round dispatch doubled to return an in-process round. Proves planted plan files on the shared volume are neither read nor overwritten, that a failed round escalates by name with no file written, and that mesh rounds keep the existing disk fallback.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanningRoundOrchestrator } from '../../src/features/swarm-orchestration/services/planning-round-orchestrator';
import {
  PlanningDecompositionError,
  TicketDecompositionService,
} from '../../src/features/swarm-orchestration/services/ticket-decomposition-service';
import type { MultiRoundDispatchService, PhaseDispatchResult } from '../../src/features/swarm-orchestration';
import type { ExternalWorkItem } from '../../src/entities/ticket';

const PM = 'a0000000-0000-0000-0000-000000000001';
const ROOT_ID = '11111111-2222-4333-8444-555555555555';
const PLAN = [
  '## Plan', '', 'Three modules.', '', '## SUBTASK DECOMPOSITION', '',
  '### Subtask 1: Build the CSV parser module', 'Parse rows. Suggested agent role: code-developer', '',
  '### Subtask 2: Build the schema validator module', 'Validate rows. Suggested agent role: code-developer', '',
  '### Subtask 3: Write unit tests for both modules', 'Cover both. Suggested agent role: test-engineer', '',
  '## AGENT_ASSIGNMENTS', '| Subtask | Role | Agent |', '|---|---|---|',
  '| Build the CSV parser module | executor | code-developer |',
  '| Build the schema validator module | executor | code-developer |',
  '| Write unit tests for both modules | tester | test-engineer |',
].join('\n');
const PLANTED = [
  '## SUBTASK DECOMPOSITION', '',
  '### Subtask 1: Planted task that must never become a child', 'Planted.', '',
  '### Subtask 2: Another planted task chosen by someone else', 'Planted.', '',
  '## AGENT_ASSIGNMENTS', '| Subtask | Role | Agent |', '|---|---|---|',
  '| Planted task that must never become a child | executor | oshal-developer |',
].join('\n');

let workspaceRoot: string;
let savedRoot: string | undefined;
let savedArchitecture: string | undefined;

/**
 * @description A planning phase result whose one round carries the given output.
 * @param output - The round output.
 * @param inProcess - Whether the round ran in-process.
 * @returns The phase dispatch result the double returns.
 */
function phaseResult(output: unknown, inProcess: boolean): PhaseDispatchResult {
  return {
    phase: 2,
    rounds: [{ agentId: PM, role: 'architect', round: 1, output, handoverValidated: true, durationMs: 1, ...(inProcess ? { executedInProcess: true } : {}) }],
    finalOutput: output,
    allRoundsComplete: false,
    allHandoversPresent: true,
  };
}

/**
 * @description The real orchestrator over the real decomposition service; multi-round dispatch is
 * doubled to return one round, and routing/persistence collaborators are no-ops.
 * @param result - What the planning phase returns.
 * @returns The orchestrator.
 */
function orchestrator(result: PhaseDispatchResult): PlanningRoundOrchestrator {
  const dispatch = { executePhaseWithRounds: async () => result } as unknown as MultiRoundDispatchService;
  return new PlanningRoundOrchestrator({
    decompositionService: new TicketDecompositionService(),
    getMultiRoundDispatch: () => dispatch,
    selectAgent: async () => ({ winner: { agentId: 'unused', score: 1, reason: 'fixture' }, ranked: [], strategy: 'catch-all' }),
    registerParentsWithLifecycle: async () => undefined,
    persistWorkItems: async () => undefined,
  });
}

function rootItem(): ExternalWorkItem {
  return {
    externalId: ROOT_ID, provider: 'direct', title: 'Build a two-module CLI', body: 'Two modules and tests.',
    status: 'approved', priority: 'low', labels: [],
    rawPayload: { ticketId: ROOT_ID, ownerSub: 'owner-sub', metadata: {} },
    metadata: {},
  } as unknown as ExternalWorkItem;
}

function plan(result: PhaseDispatchResult) {
  return orchestrator(result).execute({
    runId: 'run-1', item: rootItem(), input: {} as never, policy: {} as never,
    phaseGate: { complexity: 'low' } as never, workspaceTaskId: ROOT_ID,
  });
}

/** Plants the three files a bot with write access to the shared volume could leave behind. */
function plantFiles(): string[] {
  const planted = [
    join(workspaceRoot, ROOT_ID, 'IMPLEMENTATION-PLAN.md'),
    join(workspaceRoot, `${ROOT_ID}__${PM}`, 'IMPLEMENTATION-PLAN.md'),
    join(workspaceRoot, ROOT_ID, 'deliverables', 'plan.md'),
  ];
  for (const file of planted) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, PLANTED, 'utf8');
  }
  return planted;
}

beforeEach(() => {
  savedRoot = process.env.OSHAL_WORKSPACE_ROOT;
  savedArchitecture = process.env.USE_ARCHITECTURE_PHASE;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'planning-output-source-'));
  mkdirSync(join(workspaceRoot, ROOT_ID), { recursive: true });
  process.env.OSHAL_WORKSPACE_ROOT = workspaceRoot;
  delete process.env.USE_ARCHITECTURE_PHASE;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = savedRoot;
  if (savedArchitecture === undefined) delete process.env.USE_ARCHITECTURE_PHASE; else process.env.USE_ARCHITECTURE_PHASE = savedArchitecture;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('an in-process plan is read from memory and recorded, never read back from the shared volume', () => {
  it('decomposes the in-memory reply into its subtasks with their assignments, and records it byte for byte', async () => {
    const result = await plan(phaseResult({ agentId: PM, taskId: `${ROOT_ID}::${PM}`, content: PLAN }, true));

    expect(result.planningSource).toBe('llm-planning');
    expect(result.stopAfterPlanning).toBe(true);
    expect(result.workUnits.map((unit) => unit.title)).toEqual([
      'Build the CSV parser module', 'Build the schema validator module', 'Write unit tests for both modules',
    ]);
    expect(result.agentAssignments?.map((a) => [a.subtaskTitle, a.suggestedAgentId])).toEqual([
      ['Build the CSV parser module', 'code-developer'],
      ['Build the schema validator module', 'code-developer'],
      ['Write unit tests for both modules', 'test-engineer'],
    ]);
    const recorded = join(workspaceRoot, ROOT_ID, 'IMPLEMENTATION-PLAN.md');
    expect(result.artifactPaths.implementationPlanPath).toBe(recorded);
    expect(readFileSync(recorded, 'utf8')).toBe(PLAN);
  });

  it('a reply with no markers stays one unit wrapping the reply; planted plan files are neither read nor changed', async () => {
    const planted = plantFiles();
    const reply = 'A short plan without any decomposition section.';
    const result = await plan(phaseResult({ agentId: PM, content: reply }, true));

    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].description).toBe(reply);
    expect(JSON.stringify(result)).not.toContain('Planted');
    for (const file of planted) expect(readFileSync(file, 'utf8')).toBe(PLANTED);
    expect(result.artifactPaths.implementationPlanPath).toBeUndefined();
  });

  it('a planted IMPLEMENTATION-PLAN.md is not overwritten, and the units still come from memory', async () => {
    const [plantedPlan] = plantFiles();
    const result = await plan(phaseResult({ agentId: PM, content: PLAN }, true));

    expect(result.workUnits.map((unit) => unit.title)).toContain('Build the CSV parser module');
    expect(JSON.stringify(result.workUnits)).not.toContain('Planted');
    expect(readFileSync(plantedPlan, 'utf8')).toBe(PLANTED);
  });

  it('a failed in-process round escalates by name and writes no file', async () => {
    const failed = { status: 'failed', error: 'pm_hosted_brain_unavailable: no hosted brain resolved for the root owner' };
    const attempt = plan(phaseResult(failed, true));

    await expect(attempt).rejects.toBeInstanceOf(PlanningDecompositionError);
    await expect(attempt).rejects.toThrow('project-manager planning round failed: pm_hosted_brain_unavailable');
    expect(existsSync(join(workspaceRoot, ROOT_ID, 'IMPLEMENTATION-PLAN.md'))).toBe(false);
  });

  it('a round that returned no text escalates by name', async () => {
    await expect(plan(phaseResult({ agentId: PM, content: '   ' }, true))).rejects.toThrow('project-manager planning round returned no plan text');
  });

  it('a mesh round keeps the existing parse path, including the disk fallback', async () => {
    writeFileSync(join(workspaceRoot, ROOT_ID, 'IMPLEMENTATION-PLAN.md'), PLAN, 'utf8');
    const result = await plan(phaseResult({ agentId: PM, content: 'Plan written to disk.' }, false));

    expect(result.workUnits.map((unit) => unit.title)).toEqual([
      'Build the CSV parser module', 'Build the schema validator module', 'Write unit tests for both modules',
    ]);
  });
});
