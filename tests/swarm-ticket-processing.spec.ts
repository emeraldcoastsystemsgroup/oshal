/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added targeted regression tests for swarm verification policy and write-back retries
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation write-back regression coverage for exhausted swarm verification policy
 */

import { expect, test } from '@playwright/test';
import {
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  type ExternalWorkItem,
} from '../src/entities/ticket';
import { InMemorySwarmRunStore } from '../src/features/swarm-orchestration';
import {
  SwarmCyclePolicyService,
  SwarmRuntimeUnavailableError,
  SwarmTicketProcessingService,
  SwarmVerificationService,
  type SwarmRuntimeReadiness,
  type SwarmVerificationResult,
  type TicketWritebackUpdate,
} from '../src/features/swarm-orchestration/services';
import type { IntakeService } from '../src/features/intake';

test.describe('Swarm Ticket Processing', () => {
  test('retries build verification regression and reaches complete', async () => {
    const verificationService = new SequencedVerificationService([
      failedVerification('build', 'Execution output needs one more pass.'),
      passedVerification(),
    ]);
    const writebackAdapter = new CapturingWritebackAdapter();
    const service = createProcessingService(verificationService, writebackAdapter);

    const result = await service.processProvider('plane', {
      interactionMode: 'ticket',
      limit: 1,
      policy: {
        maxVerificationAttempts: 2,
        maxBuildRegressions: 1,
        maxWritebackAttempts: 1,
      },
    });

    expect(result.processedCount).toBe(1);
    expect(result.processed[0]?.selectedAgentId).toBe('project-manager');
    expect(result.processed[0]?.lifecycle.overallStatus).toBe('completed');
    expect(findCycleDetails(result.processed[0]?.lifecycle.cycles, 'execution')?.executionAttempts).toBe(2);
    expect(writebackAdapter.updates.at(-1)?.targetTicketState).toBe('complete');
  });

  test('retries write-back updates within the configured policy budget', async () => {
    const verificationService = new SequencedVerificationService([passedVerification()]);
    const writebackAdapter = new FlakyWritebackAdapter(1);
    const service = createProcessingService(verificationService, writebackAdapter);

    const result = await service.processProvider('plane', {
      interactionMode: 'ticket',
      limit: 1,
      policy: {
        maxWritebackAttempts: 2,
      },
    });

    expect(result.processedCount).toBe(1);
    expect(writebackAdapter.failedAttempts).toBe(1);
    expect(writebackAdapter.successfulUpdates).toBeGreaterThan(0);
  });

  test('escalates when verification policy budget is exhausted', async () => {
    const policyService = new SwarmCyclePolicyService();
    const decision = policyService.decideVerificationFailure(
      failedVerification('design', 'Plan is fundamentally incomplete.'),
      {
        verificationAttempt: 1,
        buildRegressionCount: 0,
        designRegressionCount: 1,
      },
      policyService.resolve({
        maxVerificationAttempts: 2,
        maxDesignRegressions: 1,
      }),
    );

    expect(decision.action).toBe('escalate');
    expect(decision.regressionTarget).toBe('design');
  });

  test('writes explicit human-review escalation metadata when verification budget is exhausted', async () => {
    const verificationService = new SequencedVerificationService([
      failedVerification('design', 'Plan is fundamentally incomplete.'),
    ]);
    const writebackAdapter = new CapturingWritebackAdapter();
    const service = createProcessingService(verificationService, writebackAdapter);

    await expect(service.processProvider('plane', {
      interactionMode: 'ticket',
      limit: 1,
      policy: {
        maxVerificationAttempts: 1,
        maxDesignRegressions: 0,
        maxWritebackAttempts: 1,
      },
    })).rejects.toThrow(/Verification exhausted policy budget/);

    const failureUpdate = writebackAdapter.updates.findLast(
      (update) => update.cycle === 'delivery' && update.status === 'failed',
    );

    expect(failureUpdate?.targetTicketState).toBe('escalated');
    expect(failureUpdate?.escalation?.target).toBe('human_review');
    expect(failureUpdate?.escalation?.reason).toContain('Verification exhausted policy budget');
  });

  test('blocks direct ticket processing when postgres readiness fails', async () => {
    const service = createProcessingService(
      new SequencedVerificationService([passedVerification()]),
      new CapturingWritebackAdapter(),
      async () => ({
        ready: false,
        dependency: 'postgres',
        message: 'Swarm processing cannot start because Postgres is unavailable',
      }),
    );

    await expect(service.processTickets([createWorkItem()], {})).rejects.toBeInstanceOf(SwarmRuntimeUnavailableError);
  });

  test('blocks provider processing when provider readiness fails', async () => {
    const service = createProcessingService(
      new SequencedVerificationService([passedVerification()]),
      new CapturingWritebackAdapter(),
      async () => ({
        ready: false,
        dependency: 'provider',
        message: 'Swarm processing cannot start because the provider resolver failed',
      }),
    );

    await expect(service.processProvider('plane', {
      interactionMode: 'ticket',
      limit: 1,
    })).rejects.toBeInstanceOf(SwarmRuntimeUnavailableError);
  });
});

/**
 * @description Creates a processing service wired to a single fake intake ticket and caller-supplied adapters.
 * @param verificationService - Verification service double used by the processing flow
 * @param writebackAdapter - Provider write-back adapter double used by the processing flow
 * @returns Configured swarm processing service
 */
function createProcessingService(
  verificationService: SwarmVerificationService,
  writebackAdapter: CapturingWritebackAdapter,
  readinessProbe?: () => Promise<SwarmRuntimeReadiness>,
): SwarmTicketProcessingService {
  const intakeService = {
    async pull() {
      return {
        provider: 'plane' as const,
        effectiveCursor: null,
        items: [createWorkItem()],
        source: 'test-fixture',
      };
    },
  } as IntakeService;

  return new SwarmTicketProcessingService(
    intakeService,
    new InMemorySwarmRunStore(),
    undefined,
    undefined,
    undefined,
    new SwarmCyclePolicyService(),
    verificationService,
    [writebackAdapter],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    readinessProbe,
  );
}

/**
 * @description Creates one canonical provider ticket fixture for swarm processing tests.
 * @returns Canonical provider work item
 */
function createWorkItem(): ExternalWorkItem {
  return {
    provider: 'plane',
    externalId: 'issue-123',
    title: 'Test ticket',
    body: '1. Gather requirements\n2. Implement change\n3. Validate output',
    labels: ['swarm'],
    priority: 'high',
    status: 'Todo',
    workflow: buildExternalTicketWorkflow('backlog'),
    hierarchy: buildExternalTicketHierarchy('issue-123'),
    rawPayload: { id: 'issue-123' },
  };
}

/**
 * @description Returns a passing verification result fixture.
 * @returns Passing verification result
 */
function passedVerification(): SwarmVerificationResult {
  return {
    status: 'passed',
    summary: 'Verification passed.',
    findings: ['all-checks-passed'],
  };
}

/**
 * @description Returns a failed verification result fixture with one regression target.
 * @param regressionTarget - Requested regression target
 * @param summary - Summary text for the failure
 * @returns Failed verification result
 */
function failedVerification(
  regressionTarget: 'design' | 'build',
  summary: string,
): SwarmVerificationResult {
  return {
    status: 'failed',
    summary,
    findings: ['verification-failed'],
    regressionTarget,
  };
}

/**
 * @description Finds one cycle details object from a lifecycle snapshot.
 * @param cycles - Lifecycle cycle records
 * @param cycle - Cycle name to locate
 * @returns Details object for the requested cycle
 */
function findCycleDetails(
  cycles: { cycle: string; details?: Record<string, unknown> }[] | undefined,
  cycle: string,
): Record<string, unknown> | undefined {
  return cycles?.find((entry) => entry.cycle === cycle)?.details;
}

/**
 * @description Verification service double that returns a fixed sequence of results.
 */
class SequencedVerificationService {
  private index = 0;

  constructor(private readonly results: SwarmVerificationResult[]) {}

  /**
   * @description Returns the next queued verification result.
   * @returns Verification result for the current attempt
   */
  async verify(): Promise<SwarmVerificationResult> {
    const nextIndex = Math.min(this.index, this.results.length - 1);
    this.index += 1;
    return this.results[nextIndex];
  }
}

/**
 * @description Captures provider write-back updates for assertion in tests.
 */
class CapturingWritebackAdapter {
  readonly provider = 'plane' as const;

  readonly updates: TicketWritebackUpdate[] = [];

  /**
   * @description Stores one write-back update for later assertions.
   * @param update - Write-back payload
   * @returns Promise resolved after capture
   */
  async writeCycleUpdate(update: TicketWritebackUpdate): Promise<void> {
    this.updates.push(update);
  }
}

/**
 * @description Write-back adapter double that fails a fixed number of times before succeeding.
 */
class FlakyWritebackAdapter extends CapturingWritebackAdapter {
  failedAttempts = 0;

  successfulUpdates = 0;

  constructor(private readonly failuresBeforeSuccess: number) {
    super();
  }

  /**
   * @description Fails the configured number of initial write attempts before delegating to capture logic.
   * @param update - Write-back payload
   * @returns Promise resolved after success or rejected during the configured failure window
   */
  async writeCycleUpdate(update: TicketWritebackUpdate): Promise<void> {
    if (this.failedAttempts < this.failuresBeforeSuccess) {
      this.failedAttempts += 1;
      throw new Error('Simulated write-back failure');
    }

    this.successfulUpdates += 1;
    await super.writeCycleUpdate(update);
  }
}
