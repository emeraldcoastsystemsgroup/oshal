const assert = require('assert/strict');

const {
  IntakeAssistantService,
} = require('../src/features/intake/services/intake-assistant-service');

function seedStructuredProject(service, sessionId, overrides = {}) {
  const session = service.getSession(sessionId);
  assert.ok(session, 'session should exist');

  Object.assign(session.gathered, {
    goal: 'Build a serious Google Workspace integration agent.',
    title: 'Build a serious Google Workspace integration agent.',
    outcomeType: 'integration',
    effortTier: 'professional',
    projectType: 'production',
    apiSpecs: 'Use Google Workspace APIs with production-grade auth.',
    businessRequirements: 'We need a real product-quality integration path.',
    credentialsNeeded: true,
    reviewStages: ['after planning'],
    priority: 'high',
    ...overrides,
  });
}

function main() {
  const service = new IntakeAssistantService();

  const discoverySession = service.startSession().sessionId;
  seedStructuredProject(service, discoverySession);
  const discoveryPayload = service.buildTicketPayload(discoverySession);
  assert.equal(discoveryPayload.metadata.planningEntryMode, 'discovery');
  assert.equal(discoveryPayload.metadata.planStatus, 'missing');
  assert.deepEqual(discoveryPayload.metadata.suppliedPlanningArtifactPaths, []);
  assert.ok(Array.isArray(discoveryPayload.metadata.artifactBlueprints), 'artifact blueprints should be present');
  assert.ok(
    discoveryPayload.metadata.artifactBlueprints.some((artifact) => artifact.artifactId === 'MASTER-PLAN.md'),
    'structured-project metadata should include a MASTER-PLAN blueprint',
  );
  assert.ok(
    discoveryPayload.metadata.requiredArtifacts.includes('PROCESS-FLOW.md'),
    'structured-project metadata should include PROCESS-FLOW.md',
  );
  assert.ok(
    discoveryPayload.metadata.requiredArtifacts.includes('TECHNICAL-SPECIFICATION.md'),
    'structured-project metadata should include TECHNICAL-SPECIFICATION.md',
  );
  assert.ok(
    discoveryPayload.metadata.requiredArtifacts.includes('APPLICATION-ARCHITECTURE.md'),
    'structured-project metadata should include APPLICATION-ARCHITECTURE.md',
  );
  assert.ok(
    discoveryPayload.metadata.requiredArtifacts.includes('FUNCTIONAL-SPECIFICATION.md'),
    'structured-project metadata should include FUNCTIONAL-SPECIFICATION.md',
  );
  assert.ok(
    discoveryPayload.metadata.requiredArtifacts.includes('INTEGRATION-PLAN.md'),
    'structured-project metadata should include INTEGRATION-PLAN.md',
  );
  assert.match(
    discoveryPayload.metadata.pmPrepPacket,
    /## Required Artifacts/,
    'PM prep packet should include required-artifact instructions',
  );
  assert.match(
    discoveryPayload.metadata.pmPrepPacket,
    /Standards: PMP, RALF|Standards: TOGAF, RALF/,
    'PM prep packet should include governing standards',
  );

  const suppliedSession = service.startSession().sessionId;
  seedStructuredProject(service, suppliedSession, {
    apiSpecs: 'See planning/MASTER-PLAN.md and docs/TECHNICAL-SPECIFICATION.md for the existing plan package.',
    suppliedPlanNotes: 'We already have a full plan. Validate the architecture and implementation package instead of rebuilding it.',
    suppliedPlanPaths: [
      'planning/MASTER-PLAN.md',
      'docs/TECHNICAL-SPECIFICATION.md',
    ],
  });
  const suppliedPayload = service.buildTicketPayload(suppliedSession);
  assert.equal(suppliedPayload.metadata.planningEntryMode, 'validate-existing');
  assert.equal(suppliedPayload.metadata.planStatus, 'supplied');
  assert.match(suppliedPayload.metadata.suppliedPlanSummary, /already have a full plan/i);
  assert.deepEqual(
    suppliedPayload.metadata.suppliedPlanningArtifactPaths,
    ['planning/MASTER-PLAN.md', 'docs/TECHNICAL-SPECIFICATION.md'],
  );
  assert.ok(
    suppliedPayload.metadata.suppliedPlanningArtifacts.includes('technical-architecture'),
    'supplied-plan metadata should infer a technical architecture artifact',
  );
  assert.ok(
    suppliedPayload.metadata.artifactBlueprints.some((artifact) => artifact.governingStandards.includes('TOGAF')),
    'architecture artifacts should include TOGAF governance',
  );
  assert.ok(
    suppliedPayload.metadata.artifactBlueprints.some((artifact) => artifact.governingStandards.includes('PMP')),
    'project-management artifacts should include PMP governance',
  );
  assert.ok(
    suppliedPayload.description.includes('## Supplied Plan Package'),
    'ticket description should include the supplied plan package section',
  );
  assert.match(
    suppliedPayload.metadata.pmPrepPacket,
    /## Supplied Plan Inputs/,
    'supplied-plan prep packet should call out supplied inputs',
  );
  assert.match(
    suppliedPayload.metadata.pmPrepPacket,
    /### Technical Specification \(TECHNICAL-SPECIFICATION\.md\)/i,
    'prep packet should include explicit artifact example sections',
  );
  assert.match(
    suppliedPayload.metadata.pmPrepPacket,
    /### Process Flow \(PROCESS-FLOW\.md\)/i,
    'prep packet should include the explicit process-flow artifact',
  );
  assert.match(
    suppliedPayload.metadata.pmPrepPacket,
    /### Functional Specification \(FUNCTIONAL-SPECIFICATION\.md\)/i,
    'prep packet should include the explicit functional-spec artifact',
  );

  console.log('intake-planning-metadata-contract: ok');
}

main();
