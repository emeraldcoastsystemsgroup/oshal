/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 18: Playwright tests for Phase 8, SwarmMetricsCollector wiring, cost rollup schema, credential broadcast, and architecture pre-round trigger logic
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolution-chain logging assertions updated for live-first codex resolution (619eb60, 2026-07-24): 'resolved from shared seed secrets' became a live-auth info + a SEEDED-credential warn; assert the chain as it exists.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Phase 8 Architecture Pre-Round
// ---------------------------------------------------------------------------

test.describe('Phase 8: Architecture Pre-Round trigger logic', () => {
  test('isArchitecturePhaseEnabled returns true for high complexity when env unset', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/planning-round-orchestrator.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    // Phase 8 should auto-enable for high complexity
    expect(content).toContain("return complexity === 'high'");
    // Should respect explicit env var override
    expect(content).toContain("process.env.USE_ARCHITECTURE_PHASE === 'true'");
    expect(content).toContain("process.env.USE_ARCHITECTURE_PHASE === 'false'");
  });

  test('PHASE_DESCRIPTIONS includes Phase 8', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/swarm-awareness-prompt.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('ARCHITECTURE_PRE_ROUND');
    expect(content).toContain('TECHNICAL-SPECIFICATION.md');
  });

  test('SWARM_PHASES enum includes ARCHITECTURE_PRE_ROUND = 8', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/operational-intelligence/services/competency-ranker.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('ARCHITECTURE_PRE_ROUND: 8');
  });

  test('PHASE_NAMES in handover manager includes Phase 8', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/ralf-handover-manager.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain("8: 'ARCHITECTURE_PRE_ROUND'");
  });

  test('architect agent ID matches bot registry', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const orchestratorPath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/planning-round-orchestrator.ts',
    );
    const registryPath = path.resolve(
      __dirname,
      '../src/app/extensions/swarm/swarm-bot-registry.ts',
    );
    const orchestratorContent = fs.readFileSync(orchestratorPath, 'utf8');
    const registryContent = fs.readFileSync(registryPath, 'utf8');

    // Both should reference the same UUID
    const architectUUID = 'a0000000-0000-0000-0000-000000000018';
    expect(orchestratorContent).toContain(architectUUID);
    expect(registryContent).toContain(architectUUID);
  });
});

// ---------------------------------------------------------------------------
// SwarmMetricsCollector Wiring
// ---------------------------------------------------------------------------

test.describe('SwarmMetricsCollector: wired into ticket completion', () => {
  test('recordTicketMetrics called in all processOneTicket exit paths', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    // Should have the setMetricsCollector setter
    expect(content).toContain('setMetricsCollector');
    // Should record on planning-only exit
    expect(content).toContain("this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'completed', runStartedAt");
    // Should record on escalation exits
    expect(content).toContain("this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'escalated', runStartedAt");
  });

  test('SwarmMetricsCollector wired in composition root', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/app/extensions/swarm/index.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('swarmProcessingService.setMetricsCollector(swarmMetricsCollector)');
  });

  test('SwarmMetricsCollector has recordTicketMetrics and getAggregatedMetrics methods', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/swarm-metrics-collector.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('recordTicketMetrics(metrics: TicketProcessingMetrics)');
    expect(content).toContain('getAggregatedMetrics(): AggregatedMetrics');
    expect(content).toContain('getAgentPerformance(): AgentPerformanceMetric[]');
    expect(content).toContain('computePhaseCompletionRates');
    expect(content).toContain('computeTopFailurePhases');
  });
});

// ---------------------------------------------------------------------------
// Cost Rollup Schema
// ---------------------------------------------------------------------------

test.describe('Cost rollup: recursive parent-child view', () => {
  test('ticket_cost_rollup_with_children SQL view exists in schema', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/shared/services/database/ticket-schema.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('ticket_cost_rollup_with_children');
    expect(content).toContain('WITH RECURSIVE ticket_tree');
    expect(content).toContain('child_ticket_count');
  });

  test('ticket_cost_rollup direct view still exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/shared/services/database/ticket-schema.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE VIEW ticket_cost_rollup AS');
    expect(content).toContain('total_cost');
    expect(content).toContain('total_tokens');
    expect(content).toContain('agent_count');
  });
});

// ---------------------------------------------------------------------------
// OAuth Credential Propagation
// ---------------------------------------------------------------------------

test.describe('OpenAI Codex credential broadcast', () => {
  test('OpenAiCodexOAuthService has Redis pub/sub broadcast', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/openai-codex-oauth/services/openai-codex-oauth-service.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('CODEX_CREDENTIAL_CHANNEL');
    expect(content).toContain('swarm.codex-credentials.update');
    expect(content).toContain('broadcastCodexCredentials');
    expect(content).toContain('subscribeToBroadcast');
  });

  test('swarm index subscribes to both credential channels', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/app/extensions/swarm/index.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('ClaudeCodeAuthService.subscribeToBroadcast()');
    expect(content).toContain('OpenAiCodexOAuthService.subscribeToBroadcast()');
  });
});

// ---------------------------------------------------------------------------
// Structured Logging
// ---------------------------------------------------------------------------

test.describe('Credential sync service: structured logging', () => {
  test('findOpenAiCodexCredentialBlob has resolution chain logging', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/llm-provider/services/cline-runtime-config-sync-service.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('Credential lookup: starting resolution chain');
    expect(content).toContain('Credential lookup: resolved from user-scoped secrets');
    expect(content).toContain('Credential lookup: resolved from global secrets envelope');
    // Live-first since 2026-07-24 (619eb60): the real ~/.codex/auth.json is read BEFORE the
    // never-rotated seed, and the seed fallback is a WARN, not an info — assert the chain as it
    // exists, not the pre-live-first wording this guard was written against.
    expect(content).toContain('Credential lookup: resolved from live ~/.codex/auth.json (live-first codex resolution)');
    expect(content).toContain('Credential lookup: resolved from SEEDED codex credential');
    expect(content).toContain('Credential lookup: resolved from nested envelope iteration');
    expect(content).toContain('Credential lookup: all resolution paths exhausted');
  });
});

// ---------------------------------------------------------------------------
// Architecture Diagrams
// ---------------------------------------------------------------------------

test.describe('Architecture documentation', () => {
  test('swarm-pipeline-architecture.md exists with all required diagrams', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../docs/architecture/swarm-pipeline-architecture.md',
    );
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('Phase Lifecycle Flow');
    expect(content).toContain('Agent Routing Decision Tree');
    expect(content).toContain('Cost Rollup Architecture');
    expect(content).toContain('Credential Propagation Flow');
    expect(content).toContain('Docker Container Topology');
    expect(content).toContain('Metrics Collection Flow');
    // Contains Mermaid diagrams
    expect(content).toContain('```mermaid');
  });
});

// ---------------------------------------------------------------------------
// File Size Governance
// ---------------------------------------------------------------------------

test.describe('1000-line governance compliance', () => {
  test('swarm-ticket-processing-service.ts stays under 1000 lines', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(
      __dirname,
      '../src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts',
    );
    const content = fs.readFileSync(filePath, 'utf8');
    const lineCount = content.split('\n').length;

    expect(lineCount).toBeLessThanOrEqual(1000);
  });
});
