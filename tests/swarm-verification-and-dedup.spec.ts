/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added targeted tests for mesh-routed verification, structural fallback, verdict parsing, and orphan dedup
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added structural verification coverage for work-type-aware evidence checks used by deterministic retry and review decisions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated mesh dispatch assertions to require task-manager direct-channel delivery
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for subtask-status execution persistence in swarm agent worker
 */

import { expect, test } from '@playwright/test';
import { MESH_CHANNELS } from '../src/features/agent-management/services/mesh-communication-service';
import {
  SwarmVerificationService,
  type SwarmVerificationResult,
} from '../src/features/swarm-orchestration/services';
import type { MeshEnvelope, MeshTransport } from '../src/features/agent-management';
import type { DecomposedWorkUnit } from '../src/features/swarm-orchestration/services/ticket-decomposition-service';
import {
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  type ExternalWorkItem,
} from '../src/entities/ticket';
import { SwarmAgentWorker } from '../src/features/swarm-orchestration/services/swarm-agent-worker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createWorkItem(): ExternalWorkItem {
  return {
    provider: 'plane',
    externalId: 'verify-test-001',
    title: 'Test verification ticket',
    body: 'Implement the widget and validate output quality.',
    labels: ['swarm'],
    priority: 'high',
    status: 'Todo',
    workflow: buildExternalTicketWorkflow('backlog'),
    hierarchy: buildExternalTicketHierarchy('verify-test-001'),
    rawPayload: { id: 'verify-test-001' },
  };
}

function createWorkUnits(): DecomposedWorkUnit[] {
  return [
    {
      unitId: 'unit-1',
      title: 'Implement widget',
      description: 'Build the widget component with proper styling.',
      acceptanceCriteria: ['Widget renders correctly', 'Styling matches design'],
      labels: ['frontend'],
      priority: 'high',
    },
  ];
}

// ---------------------------------------------------------------------------
// Test doubles — MeshTransport
// ---------------------------------------------------------------------------

class CapturingMeshTransport implements MeshTransport {
  readonly publishedEnvelopes: MeshEnvelope[] = [];

  async publish(envelope: MeshEnvelope): Promise<void> {
    this.publishedEnvelopes.push(envelope);
  }
}

// ---------------------------------------------------------------------------
// Test doubles — WorkItemRepository (partial, method-level stubs)
// ---------------------------------------------------------------------------

interface InMemoryWorkItem {
  workItemId: string;
  externalId: string;
  provider: string;
  status: string;
  executionOutput: unknown;
  assignedAgentId?: string;
}

class InMemoryWorkItemRepository {
  readonly items: InMemoryWorkItem[] = [];

  async findByExternalId(externalId: string, provider: string): Promise<InMemoryWorkItem[]> {
    return this.items.filter((i) => i.externalId === externalId && i.provider === provider);
  }

  async findByExternalIdAnyProvider(externalId: string): Promise<InMemoryWorkItem[]> {
    return this.items.filter((i) => i.externalId === externalId);
  }

  async create(input: {
    externalId: string;
    provider: string;
    swarmRunId: string;
    unitId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    labels: string[];
    priority?: string;
  }): Promise<InMemoryWorkItem> {
    const item: InMemoryWorkItem = {
      workItemId: `wi-${this.items.length + 1}`,
      externalId: input.externalId,
      provider: input.provider,
      status: 'pending',
      executionOutput: null,
    };
    this.items.push(item);
    return item;
  }

  async setExecutionOutput(workItemId: string, output: unknown): Promise<void> {
    const item = this.items.find((i) => i.workItemId === workItemId);
    if (item) {
      item.executionOutput = output;
    }
  }

  async updateStatus(workItemId: string, status: string): Promise<void> {
    const item = this.items.find((i) => i.workItemId === workItemId);
    if (item) {
      item.status = status;
    }
  }

  addItem(partial: Partial<InMemoryWorkItem> & { externalId: string }): void {
    this.items.push({
      workItemId: partial.workItemId || `wi-${this.items.length + 1}`,
      externalId: partial.externalId,
      provider: partial.provider || 'plane',
      status: partial.status || 'pending',
      executionOutput: partial.executionOutput ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Test doubles — RedisMeshTransport (minimal for SwarmAgentWorker)
// ---------------------------------------------------------------------------

class FakeRedisMeshTransport {
  readonly ackedEntryIds: string[] = [];
  readonly publishedEnvelopes: MeshEnvelope[] = [];
  consumeQueue: { entryId: string; envelope: MeshEnvelope }[] = [];

  async publish(envelope: MeshEnvelope): Promise<void> {
    this.publishedEnvelopes.push(envelope);
  }

  async consume(_channel: string, _consumerId: string, _count?: number): Promise<{ entryId: string; envelope: MeshEnvelope }[]> {
    const batch = [...this.consumeQueue];
    this.consumeQueue = [];
    return batch;
  }

  async ack(_channel: string, entryId: string): Promise<void> {
    this.ackedEntryIds.push(entryId);
  }

  async claimOrphaned(_channel: string, _consumerId: string): Promise<{ entryId: string; envelope: MeshEnvelope }[]> {
    return [];
  }

  async disconnect(): Promise<void> {}
}

// ===========================================================================
// Tests: SwarmVerificationService — Structural Fallback
// ===========================================================================

test.describe('SwarmVerificationService — Structural Checks', () => {
  test('passes when work units, agent, and output are valid (no mesh)', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a substantive execution output that is longer than fifty characters for the length check.',
    );

    expect(result.status).toBe('passed');
    expect(result.findings).toContain('structural-checks-passed');
  });

  test('fails design when work units are empty', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      [],
      'agent-code-developer',
      'Some output here.',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('design');
    expect(result.findings).toContain('no-work-units-produced');
  });

  test('fails design when work unit has no acceptance criteria', async () => {
    const service = new SwarmVerificationService();
    const workUnits: DecomposedWorkUnit[] = [{
      unitId: 'unit-1',
      title: 'Empty criteria unit',
      description: 'Has a description but no criteria.',
      acceptanceCriteria: [],
      labels: [],
    }];

    const result = await service.verify(
      createWorkItem(),
      workUnits,
      'agent-code-developer',
      'Some output here that is long enough to pass the length check requirement.',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('design');
    expect(result.findings).toContain('missing-acceptance-criteria:unit-1');
  });

  test('fails build when no execution output is provided', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toContain('no-execution-output');
  });

  test('fails build when execution output contains a terminal execution error', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      { status: 'failed', error: 'Cline runtime failed before completion: Command failed with exit code 1' },
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toContain('agent-execution-failed');
    expect(result.findings.some((finding) => finding.startsWith('execution-error:'))).toBe(true);
  });

  test('fails build when execution output is too short', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'Short',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings.some((f) => f.startsWith('output-too-short:'))).toBe(true);
  });

  test('fails build when testing work lacks testing evidence in the output', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      [{
        unitId: 'unit-test-1',
        title: 'Write auth tests',
        description: 'Write tests for the auth refresh flow.',
        acceptanceCriteria: ['Relevant tests are added and pass.'],
        labels: ['auth'],
        priority: 'high',
        workType: 'testing',
      }],
      'agent-test-engineer',
      'Implemented the refresh flow logic and updated the service code, but no validation details were recorded here.',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toContain('missing-testing-evidence:unit-test-1');
  });

  test('passes when documentation work includes documentation evidence in the output', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      [{
        unitId: 'unit-doc-1',
        title: 'Update README',
        description: 'Document the auth setup steps in README.',
        acceptanceCriteria: ['README is updated with accurate setup guidance.'],
        labels: ['docs'],
        priority: 'medium',
        workType: 'documentation',
      }],
      'agent-documentation-writer',
      'Updated the README with setup, usage, and troubleshooting documentation for the auth flow.',
    );

    expect(result.status).toBe('passed');
    expect(result.findings).toContain('structural-checks-passed');
  });

  test('fails build when agent ID is empty', async () => {
    const service = new SwarmVerificationService();
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      '',
      'Some output here that is definitely long enough for the check.',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings).toContain('missing-selected-agent');
  });
});

// ===========================================================================
// Tests: SwarmVerificationService — Mesh-Routed Dispatch
// ===========================================================================

test.describe('SwarmVerificationService — Mesh Dispatch', () => {
  // Mesh dispatch tests require MOCK_OIDC to be disabled so verify() reaches the mesh path
  const originalMockOidc = process.env.MOCK_OIDC;
  test.beforeAll(() => { process.env.MOCK_OIDC = 'false'; });
  test.afterAll(() => { process.env.MOCK_OIDC = originalMockOidc ?? 'true'; });

  test('publishes verification envelope to task-manager when mesh deps are available', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();

    // Pre-seed a completed verification work item so awaitVerificationOutput resolves
    workItemRepo.addItem({
      externalId: 'verify:verify-test-001',
      provider: 'plane',
      status: 'completed',
      executionOutput: 'Verdict: APPROVED\n\nAll acceptance criteria met.',
    });

    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a substantive execution output that should be verified by the task-manager agent for quality.',
    );

    // Verify the envelope was published to the task-manager
    expect(meshTransport.publishedEnvelopes.length).toBe(1);
    const envelope = meshTransport.publishedEnvelopes[0];
    expect(envelope.toAgentId).toBe('a0000000-0000-0000-0000-000000000006');
    expect(envelope.channel).toBe(MESH_CHANNELS.agentDirect('a0000000-0000-0000-0000-000000000006'));
    expect(envelope.fromAgentId).toBe('swarm-controller');
    expect((envelope.payload as any).type).toBe('verification-request');
    expect((envelope.payload as any).externalId).toBe('verify:verify-test-001');

    // Verify the result was parsed from the task-manager's output
    expect(result.status).toBe('passed');
    expect(result.findings).toContain('task-manager-approved');
  });

  test('creates a verification work item before dispatch so polling has a result target', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    (service as any).awaitVerificationOutput = async () => 'Verdict: APPROVED\n\nAll acceptance criteria met.';

    await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a substantive execution output that should be verified by the task-manager agent for quality.',
    );

    const verificationItem = workItemRepo.items.find((item) => item.externalId === 'verify:verify-test-001');
    expect(verificationItem).toBeTruthy();
    expect(verificationItem?.status).toBe('assigned');
  });

  test('falls back to structural checks when task-manager verdict is not available', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();

    // No completed verification work item — awaitVerificationOutput will time out
    // Override the timeout to avoid waiting
    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    // Monkey-patch the private awaitVerificationOutput to simulate timeout
    (service as any).awaitVerificationOutput = async () => undefined;

    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a substantive execution output that should pass structural checks when mesh times out.',
    );

    // Falls back to structural result
    expect(result.status).toBe('passed');
    expect(result.findings).toContain('structural-checks-passed');
  });

  test('structural failure short-circuits before mesh dispatch', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();

    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    // No execution output → structural build failure → no mesh dispatch
    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
    );

    expect(result.status).toBe('failed');
    expect(result.regressionTarget).toBe('build');
    expect(meshTransport.publishedEnvelopes.length).toBe(0);
  });
});

// ===========================================================================
// Tests: Task-Manager Verdict Parsing
// ===========================================================================

test.describe('SwarmVerificationService — Verdict Parsing', () => {
  const originalMockOidc = process.env.MOCK_OIDC;
  test.beforeAll(() => { process.env.MOCK_OIDC = 'false'; });
  test.afterAll(() => { process.env.MOCK_OIDC = originalMockOidc ?? 'true'; });

  test('parses APPROVED verdict from task-manager output', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    workItemRepo.addItem({
      externalId: 'verify:verify-test-001',
      provider: 'plane',
      status: 'completed',
      executionOutput: '## QA VALIDATION REPORT\n\nVerdict: APPROVED\n\nAll acceptance criteria satisfied.',
    });

    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a long enough execution output for structural checks to pass before mesh routing.',
    );

    expect(result.status).toBe('passed');
    expect(result.findings).toContain('task-manager-approved');
    expect(result.findings).toContain('qa-validation-passed');
  });

  test('parses REJECTED verdict from task-manager output', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    workItemRepo.addItem({
      externalId: 'verify:verify-test-001',
      provider: 'plane',
      status: 'completed',
      executionOutput: '## QA VALIDATION REPORT\n\nVerdict: REJECTED\n\n- Widget component does not render correctly\n- Styling is missing entirely from the deliverable',
    });

    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a long enough execution output for structural checks to pass before mesh routing.',
    );

    expect(result.status).toBe('failed');
    expect(result.findings).toContain('task-manager-rejected');
    expect(result.regressionTarget).toBe('build');
    expect(result.findings.some((f) => f.startsWith('tm-finding:'))).toBe(true);
  });

  test('parses NEEDS REVISION verdict from task-manager output', async () => {
    const meshTransport = new CapturingMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    workItemRepo.addItem({
      externalId: 'verify:verify-test-001',
      provider: 'plane',
      status: 'completed',
      executionOutput: 'Verdict: ⚠\n\nThis needs revision.\n\n- The output is partially complete but missing edge cases\n- Error handling is not present in the widget component',
    });

    const service = new SwarmVerificationService({
      meshTransport,
      workItemRepository: workItemRepo as any,
    });

    const result = await service.verify(
      createWorkItem(),
      createWorkUnits(),
      'agent-code-developer',
      'This is a long enough execution output for structural checks to pass before mesh routing.',
    );

    expect(result.status).toBe('failed');
    expect(result.findings).toContain('task-manager-needs-revision');
    expect(result.regressionTarget).toBe('build');
  });
});

// ===========================================================================
// Tests: SwarmAgentWorker — Orphan Deduplication
// ===========================================================================

test.describe('SwarmAgentWorker — Orphan Deduplication', () => {
  test('skips execution and ACKs when work item is already completed', async () => {
    const transport = new FakeRedisMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    let handlerCalled = false;

    workItemRepo.addItem({
      externalId: 'issue-completed-001',
      provider: 'plane',
      status: 'completed',
      executionOutput: { result: 'already done' },
    });

    const envelope: MeshEnvelope = {
      correlationId: 'orphan-test-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'issue-completed-001' },
    };

    transport.consumeQueue.push({ entryId: 'entry-orphan-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      workItemRepository: workItemRepo as any,
      handler: async () => {
        handlerCalled = true;
        return { success: true, output: 'should not happen' };
      },
    });

    await worker.start();
    // Give the poll loop one tick to process
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    // Handler should NOT have been called — orphan dedup skipped it
    expect(handlerCalled).toBe(false);
    // Entry should have been ACKed to clear it from the stream
    expect(transport.ackedEntryIds).toContain('entry-orphan-1');
  });

  test('executes normally when work item is not yet completed', async () => {
    const transport = new FakeRedisMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    let handlerCalled = false;

    workItemRepo.addItem({
      externalId: 'issue-pending-001',
      provider: 'plane',
      status: 'assigned',
      executionOutput: null,
    });

    const envelope: MeshEnvelope = {
      correlationId: 'normal-test-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'issue-pending-001' },
    };

    transport.consumeQueue.push({ entryId: 'entry-normal-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      workItemRepository: workItemRepo as any,
      handler: async () => {
        handlerCalled = true;
        return { success: true, output: 'execution result' };
      },
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    // Handler SHOULD have been called
    expect(handlerCalled).toBe(true);
    expect(transport.ackedEntryIds).toContain('entry-normal-1');
  });

  test('executes when no work item repository is configured (fails open)', async () => {
    const transport = new FakeRedisMeshTransport();
    let handlerCalled = false;

    const envelope: MeshEnvelope = {
      correlationId: 'no-repo-test-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'issue-no-repo-001' },
    };

    transport.consumeQueue.push({ entryId: 'entry-no-repo-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      handler: async () => {
        handlerCalled = true;
        return { success: true, output: 'execution result' };
      },
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    // No repo → fails open → handler runs
    expect(handlerCalled).toBe(true);
    expect(transport.ackedEntryIds).toContain('entry-no-repo-1');
  });

  test('persists failed execution results so orchestration can stop polling on terminal error', async () => {
    const transport = new FakeRedisMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();

    workItemRepo.addItem({
      externalId: 'issue-failed-001',
      provider: 'plane',
      status: 'assigned',
      executionOutput: null,
    });

    const envelope: MeshEnvelope = {
      correlationId: 'failed-test-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'issue-failed-001' },
    };

    transport.consumeQueue.push({ entryId: 'entry-failed-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      workItemRepository: workItemRepo as any,
      handler: async () => ({
        success: false,
        error: 'Cline runtime failed before completion: Command failed with exit code 1',
      }),
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    expect(transport.ackedEntryIds).toContain('entry-failed-1');
    expect(workItemRepo.items[0]?.status).toBe('failed');
    expect(workItemRepo.items[0]?.executionOutput).toEqual({
      status: 'failed',
      error: 'Cline runtime failed before completion: Command failed with exit code 1',
      output: null,
    });
  });

  test('persists successful execution for subtask work items using subtask terminal statuses', async () => {
    const transport = new FakeRedisMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();

    workItemRepo.addItem({
      externalId: 'subtask-unit-001',
      provider: 'plane',
      status: 'subtask-assigned',
      executionOutput: null,
    });

    const envelope: MeshEnvelope = {
      correlationId: 'subtask-success-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'subtask-unit-001' },
    };

    transport.consumeQueue.push({ entryId: 'entry-subtask-success-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      workItemRepository: workItemRepo as any,
      handler: async () => ({ success: true, output: 'subtask output' }),
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    expect(transport.ackedEntryIds).toContain('entry-subtask-success-1');
    expect(workItemRepo.items[0]?.status).toBe('subtask-completed');
    expect(workItemRepo.items[0]?.executionOutput).toBe('subtask output');
  });

  test('treats subtask-completed rows as already completed during orphan dedup', async () => {
    const transport = new FakeRedisMeshTransport();
    const workItemRepo = new InMemoryWorkItemRepository();
    let handlerCalled = false;

    workItemRepo.addItem({
      externalId: 'subtask-unit-002',
      provider: 'plane',
      status: 'subtask-completed',
      executionOutput: { result: 'done' },
    });

    const envelope: MeshEnvelope = {
      correlationId: 'subtask-dedup-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'agent-code-developer',
      channel: 'swarm.ticket.execute',
      payload: { externalId: 'subtask-unit-002' },
    };

    transport.consumeQueue.push({ entryId: 'entry-subtask-dedup-1', envelope });

    const worker = new SwarmAgentWorker({
      transport: transport as any,
      workItemRepository: workItemRepo as any,
      handler: async () => {
        handlerCalled = true;
        return { success: true, output: 'should not happen' };
      },
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();

    expect(handlerCalled).toBe(false);
    expect(transport.ackedEntryIds).toContain('entry-subtask-dedup-1');
  });
});
