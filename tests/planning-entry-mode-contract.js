const assert = require('assert/strict');

const {
  PlanningRoundOrchestrator,
} = require('../src/features/swarm-orchestration/services/planning-round-orchestrator');

async function runScenario({ metadata = {}, complexity = 'medium' } = {}) {
  const dispatched = [];

  const orchestrator = new PlanningRoundOrchestrator({
    decompositionService: {
      async decomposeFromPlanningOutput() {
        return {
          workUnits: [
            {
              unitId: 'unit-1',
              title: 'Build the implementation',
              description: 'Implement the approved build path.',
              acceptanceCriteria: ['tests pass'],
              labels: [],
              priority: 'medium',
              workType: 'implementation',
              parentUnitId: null,
              depth: 0,
            },
          ],
          agentAssignments: [],
        };
      },
    },
    getMultiRoundDispatch: () => ({
      async executePhaseWithRounds(_runId, _ticketId, phase, workUnits) {
        dispatched.push({
          phase,
          title: workUnits[0]?.title,
          description: workUnits[0]?.description,
        });
        return {
          phase,
          rounds: [],
          finalOutput: [
            '## SUBTASK DECOMPOSITION',
            '### Subtask 1: Build the implementation',
            'Description: Implement the approved build path.',
            'Suggested agent role: code-developer',
          ].join('\n'),
          allRoundsComplete: true,
          handoversEnforced: true,
        };
      },
    }),
    selectAgent: async () => ({
      winner: { agentId: 'code-developer', score: 1, reason: 'test' },
      ranked: [{ agentId: 'code-developer', score: 1, reason: 'test' }],
      strategy: 'score',
    }),
    registerParentsWithLifecycle: async () => {},
    persistWorkItems: async () => {},
  });

  const result = await orchestrator.execute({
    runId: 'run-1',
    item: {
      provider: 'direct',
      externalId: 'ticket-1',
      title: 'Build something important',
      body: 'Ticket body for planning orchestration.',
      labels: ['integration'],
      priority: 'high',
      rawPayload: { metadata },
    },
    input: {
      workspaceTaskId: 'planning-entry-mode-contract',
    },
    policy: {},
    phaseGate: {
      complexity,
    },
    workspaceTaskId: 'planning-entry-mode-contract',
  });

  return { dispatched, result };
}

async function main() {
  const previousEnv = process.env.USE_ARCHITECTURE_PHASE;

  process.env.USE_ARCHITECTURE_PHASE = 'false';
  const discovery = await runScenario();
  const discoveryPlanning = discovery.dispatched.find((entry) => entry.phase === 2);
  assert.ok(discoveryPlanning, 'discovery path should dispatch planning work');
  assert.match(discoveryPlanning.description, /planning authority/i);
  assert.doesNotMatch(discoveryPlanning.description, /validate, tighten, resource/i);
  assert.equal(discovery.result.stopAfterPlanning, true, 'structured discovery tickets should stop after planning for human approval');

  const legacyStructuredProject = await runScenario({
    metadata: {
      requiredArtifacts: [
        'technical-architecture',
        'functional-specification',
        'integration-plan',
      ],
    },
  });
  const legacyPlanning = legacyStructuredProject.dispatched.find((entry) => entry.phase === 2);
  assert.ok(legacyPlanning, 'legacy structured-project metadata should still dispatch planning work');
  assert.match(legacyPlanning.description, /planning authority/i);
  assert.doesNotMatch(legacyPlanning.description, /supplied plan package/i);
  assert.equal(legacyStructuredProject.result.stopAfterPlanning, true, 'legacy structured-project tickets should also stop after planning');

  const directExecution = await runScenario({
    metadata: {
      recommendedPath: 'direct-execution',
      planningMode: 'lightweight',
      outcomeType: 'integration',
    },
  });
  const directPlanning = directExecution.dispatched.find((entry) => entry.phase === 2);
  assert.equal(directPlanning, undefined, 'direct-execution root tickets should bypass PM planning');
  assert.equal(directExecution.result.planningSource, 'root-direct');
  assert.equal(directExecution.result.workUnits.length, 1);

  const instantAnswer = await runScenario({
    metadata: {
      recommendedPath: 'instant-answer',
      planningMode: 'none',
      outcomeType: 'question-answer',
    },
  });
  const instantPlanning = instantAnswer.dispatched.find((entry) => entry.phase === 2);
  assert.equal(instantPlanning, undefined, 'instant-answer root tickets should bypass PM planning');
  assert.equal(instantAnswer.result.planningSource, 'root-direct');
  assert.match(instantAnswer.result.workUnits[0].description, /instant-answer work/i);
  assert.match(instantAnswer.result.workUnits[0].description, /can i answer this quickly as a verbal response/i);

  process.env.USE_ARCHITECTURE_PHASE = 'true';
  const supplied = await runScenario({
    complexity: 'high',
    metadata: {
      planningEntryMode: 'validate-existing',
      planStatus: 'supplied',
      suppliedPlanSummary: 'User already supplied a serious implementation plan and wants PM validation only.',
      suppliedPlanningArtifacts: [
        'technical-architecture',
        'functional-specification',
        'integration-plan',
        'product-diagrams',
      ],
      suppliedPlanningArtifactPaths: [
        'deliverables/TECHNICAL-SPECIFICATION.md',
        'deliverables/MASTER-PLAN.md',
      ],
      artifactBlueprints: [
        {
          artifactId: 'technical-architecture',
          displayName: 'Technical Architecture',
          purpose: 'Define the system shape before implementation starts.',
          ownerRole: 'architect-bot',
          governingStandards: ['TOGAF', 'RALF'],
          minimumContents: ['components', 'data flow'],
          exampleOutline: ['system context', 'component map'],
        },
      ],
      pmPrepPacket: [
        '# PM-PREP-PACKET',
        '## PM Instructions',
        '1. Validate the supplied package before creating new planning artifacts.',
      ].join('\n'),
    },
  });

  const suppliedPlanning = supplied.dispatched.find((entry) => entry.phase === 2);
  const suppliedArchitecture = supplied.dispatched.find((entry) => entry.phase === 8);
  assert.ok(suppliedPlanning, 'supplied-plan path should dispatch planning work');
  assert.ok(suppliedArchitecture, 'supplied-plan path should still allow architecture review');
  assert.match(suppliedPlanning.description, /supplied plan package/i);
  assert.match(suppliedPlanning.description, /## PLAN VALIDATION/);
  assert.match(suppliedPlanning.description, /## RESOURCING CHECK/);
  assert.match(suppliedPlanning.description, /technical-architecture/);
  assert.match(suppliedPlanning.description, /PM-PREP-PACKET\.md/);
  assert.match(suppliedPlanning.description, /## Project Preparation Packet/);
  assert.match(suppliedPlanning.description, /Validate the supplied package before creating new planning artifacts/i);
  assert.match(suppliedPlanning.description, /PMP-style project controls/i);
  assert.match(suppliedArchitecture.description, /reviewing a supplied plan package/i);
  assert.equal(supplied.result.planningSource, 'llm-planning');
  assert.equal(supplied.result.stopAfterPlanning, true, 'supplied-plan validation should still stop for human approval before build');

  if (previousEnv === undefined) {
    delete process.env.USE_ARCHITECTURE_PHASE;
  } else {
    process.env.USE_ARCHITECTURE_PHASE = previousEnv;
  }

  console.log('planning-entry-mode-contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
