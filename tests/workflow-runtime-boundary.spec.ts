/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow-studio and runtime workflow registry boundary regression coverage
 */

import { test, expect } from '@playwright/test';
import {
  buildSeedWorkflowDefinition,
  compileWorkflowDefinition,
  validateWorkflowDefinition,
} from '@/features/workflow-studio';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration/services/workflow-pipeline-registry';

test.describe('workflow runtime boundary contracts', () => {
  test('workflow-studio compiles a design-time preview without taking runtime ownership', () => {
    const definition = buildSeedWorkflowDefinition({
      name: 'Ledger Workflow Proof',
      description: 'Regression proof for workflow-studio compile boundaries.',
    });
    const context = {
      rosterStatus: 'available' as const,
      agents: [
        {
          agentId: 'worker-a',
          name: 'worker-a',
          status: 'active',
          baseCapabilities: ['implementation', 'verification', 'review'],
          routingKeywords: ['build', 'review'],
        },
      ],
    };

    const validation = validateWorkflowDefinition(definition, context);
    const preview = compileWorkflowDefinition(definition, context);

    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((issue) => issue.level === 'error')).toHaveLength(0);
    expect(preview.integrationMode).toBe('design_time_only');
    expect(preview.stepBindings.length).toBe(definition.nodes.length);
    expect(preview.runtimeBindings).toEqual(expect.arrayContaining([
      'workflow-bootstrap',
      'planning-round-orchestrator',
      'phase-routing-service',
      'ticket-cycle-state-machine',
      'swarm-verification-service',
      'swarm-writeback-handler',
    ]));
    expect(preview.nonInterferenceRules.join('\n')).toContain('Design-time definitions do not replace swarm routing');
  });

  test('manifest workflows can register runtime routes but cannot override built-ins', () => {
    const registry = WorkflowPipelineRegistry.getInstance();
    registry.unregisterApp('ledger-workflow-app');
    registry.unregisterApp('ledger-hijack-app');

    const accepted = registry.registerFromApp('ledger-workflow-app', {
      ticketType: 'ledger-custom-ticket',
      name: 'Ledger Custom Ticket Workflow',
      pipeline: 'ledger-single-worker',
      workerBot: 'ledger-worker',
      reviewerBot: 'queue-bot',
      maxRevisions: 2,
    });

    expect(accepted).toBe(true);
    expect(registry.resolve('ledger-custom-ticket')).toMatchObject({
      ticketType: 'ledger-custom-ticket',
      pipeline: 'ledger-single-worker',
      workerBot: 'ledger-worker',
      reviewerBot: 'queue-bot',
      maxRevisions: 2,
    });

    const rejected = registry.registerFromApp('ledger-hijack-app', {
      ticketType: 'build',
      name: 'Hijacked Build Workflow',
      pipeline: 'ledger-hijack',
      workerBot: 'ledger-worker',
    });

    expect(rejected).toBe(false);
    expect(registry.resolve('build')).not.toMatchObject({
      name: 'Hijacked Build Workflow',
      pipeline: 'ledger-hijack',
    });

    expect(registry.unregisterApp('ledger-workflow-app')).toBe(1);
    expect(registry.resolve('ledger-custom-ticket')).toBeUndefined();
  });
});
