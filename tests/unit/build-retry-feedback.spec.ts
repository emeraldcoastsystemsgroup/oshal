/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the feedback-carrying build retry (docs/backlog/test-lab.md #2): (a) the policy runner's SECOND dispatchExecution call carries the previous attempt's verification findings as retryFeedback — goes red if the retry ever becomes a blind re-roll again; (b) a design regression CLEARS the feedback (re-planned units invalidate old findings); (c) buildExecutionUserMessage renders the "== RETRY" section only when payload.retryFeedback is present (non-retry prompts byte-identical); (d) the code-developer persona keeps its Deliverables Contract (deliverables/src/ + deliverables/tests/ + ls self-verify).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SwarmExecutionPolicyRunner, type SwarmExecutionPolicyCallbacks } from '../../src/features/swarm-orchestration/services/swarm-execution-policy-runner';
import { SwarmCyclePolicyService } from '../../src/features/swarm-orchestration/services/swarm-cycle-policy';
import type { SwarmVerificationResult, SwarmVerificationService } from '../../src/features/swarm-orchestration/services/swarm-verification-service';
import type { TicketDecompositionService, DecomposedWorkUnit } from '../../src/features/swarm-orchestration/services/ticket-decomposition-service';
import type { SwarmProcessingInput } from '../../src/features/swarm-orchestration/services/swarm-ticket-processing-service';
import { buildUserMessage } from '../../src/features/swarm-orchestration/services/llm-execution-handler';
import type { MeshEnvelope } from '../../src/features/agent-management/services/mesh-communication-service';
import type { ExternalWorkItem } from '../../src/entities/ticket';
import type { RouteDecision } from '../../src/features/agent-management';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ITEM = {
  externalId: 't-retry-1',
  title: 'Build a phone validator',
  body: 'Implement validate_phone().',
} as unknown as ExternalWorkItem;

const ROUTING = { winner: { agentId: 'agent-dev-1' }, strategy: 'test' } as unknown as RouteDecision;

const UNITS = [
  { unitId: 'u1', title: 'Implement validator', description: 'write it', acceptanceCriteria: [], workType: 'implementation', depth: 0 },
] as unknown as DecomposedWorkUnit[];

/** Verification stub that replays a scripted sequence of results, one per attempt. */
function scriptedVerification(results: SwarmVerificationResult[]): SwarmVerificationService {
  let call = 0;
  return {
    verify: async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  } as unknown as SwarmVerificationService;
}

const FAILED_EMPTY_DELIVERABLES: SwarmVerificationResult = {
  status: 'failed',
  summary: 'No deliverables produced',
  findings: ['deliverables-directory-empty'],
};

const PASSED: SwarmVerificationResult = { status: 'passed', summary: 'ok', findings: [] };

function makeRunner(verification: SwarmVerificationService): SwarmExecutionPolicyRunner {
  const decomposition = { decompose: () => UNITS } as unknown as TicketDecompositionService;
  return new SwarmExecutionPolicyRunner(verification, new SwarmCyclePolicyService(), decomposition);
}

function recordingCallbacks(dispatchLog: Array<string | undefined>): SwarmExecutionPolicyCallbacks {
  return {
    dispatchExecution: async (_routing, _workUnits, retryFeedback) => {
      dispatchLog.push(retryFeedback);
      return 'output';
    },
    reroute: () => ROUTING,
  };
}

const POLICY = new SwarmCyclePolicyService().resolve({ verificationRetryDelayMs: 0 });

// ── (a) The retry dispatch carries the verifier's findings ─────────────────────

describe('build retry carries verification feedback (blind re-roll guard)', () => {
  it('second dispatchExecution receives retryFeedback naming the deliverables finding', async () => {
    const dispatchLog: Array<string | undefined> = [];
    const runner = makeRunner(scriptedVerification([FAILED_EMPTY_DELIVERABLES, PASSED]));

    const outcome = await runner.run(
      ITEM, {} as SwarmProcessingInput, UNITS, ROUTING, POLICY, recordingCallbacks(dispatchLog),
    );

    expect(outcome.verification.status).toBe('passed');
    expect(dispatchLog).toHaveLength(2);
    // First attempt is not a retry — no feedback.
    expect(dispatchLog[0]).toBeUndefined();
    // The RETRY attempt must carry the exact verifier finding, not be a blind re-roll.
    expect(dispatchLog[1]).toBeDefined();
    expect(dispatchLog[1]).toContain('deliverables-directory-empty');
    expect(dispatchLog[1]).toContain('No deliverables produced');
  });

  it('a design regression clears the feedback — re-planned units invalidate old findings', async () => {
    const dispatchLog: Array<string | undefined> = [];
    const designFailure: SwarmVerificationResult = {
      status: 'failed',
      summary: 'Wrong approach entirely',
      findings: ['solution-does-not-match-requirements'],
      regressionTarget: 'design',
    };
    const runner = makeRunner(scriptedVerification([FAILED_EMPTY_DELIVERABLES, designFailure, PASSED]));

    const outcome = await runner.run(
      ITEM, {} as SwarmProcessingInput, UNITS, ROUTING, POLICY, recordingCallbacks(dispatchLog),
    );

    expect(outcome.verification.status).toBe('passed');
    expect(dispatchLog).toHaveLength(3);
    expect(dispatchLog[0]).toBeUndefined();
    expect(dispatchLog[1]).toContain('deliverables-directory-empty');
    // After the design regression the plan changed — stale findings must NOT leak in.
    expect(dispatchLog[2]).toBeUndefined();
  });
});

// ── (b/c) Prompt rendering: RETRY section present iff payload.retryFeedback ───

function envelope(payload: Record<string, unknown>): MeshEnvelope {
  return {
    correlationId: 'c-1',
    fromAgentId: 'queue-manager',
    toAgentId: 'a0000000-0000-0000-0000-000000000002',
    channel: 'agent.a0000000-0000-0000-0000-000000000002',
    messageType: 'request',
    payload,
  } as MeshEnvelope;
}

describe('buildExecutionUserMessage retry section', () => {
  const basePayload = {
    externalId: 't-retry-1',
    workspaceTaskId: 't-retry-1',
    workUnits: [{ description: 'Implement validator', acceptanceCriteria: ['works'] }],
    phase: 4,
  };

  it('renders the RETRY section with the verifier findings when retryFeedback is set', () => {
    const msg = buildUserMessage(envelope({
      ...basePayload,
      retryFeedback: 'No deliverables produced | deliverables-directory-empty',
    }));
    expect(msg).toContain('== RETRY — YOUR PREVIOUS ATTEMPT FAILED VERIFICATION ==');
    expect(msg).toContain('deliverables-directory-empty');
    expect(msg).toContain('deliverables/src/');
    expect(msg).toContain('deliverables/tests/');
  });

  it('omits the RETRY section entirely when retryFeedback is absent (non-retry prompts unchanged)', () => {
    const msg = buildUserMessage(envelope(basePayload));
    expect(msg).not.toContain('== RETRY');
  });

  it('ignores a blank retryFeedback value', () => {
    const msg = buildUserMessage(envelope({ ...basePayload, retryFeedback: '   ' }));
    expect(msg).not.toContain('== RETRY');
  });
});

// ── (d) Persona deliverables contract stays in the executor persona ────────────

describe('code-developer persona deliverables contract', () => {
  const personaPath = resolve(process.cwd(), 'ai-lab/bot-personas/code-developer.yaml');
  const personaText = readFileSync(personaPath, 'utf8');

  it('mandates deliverables/src/ and deliverables/tests/ outputs', () => {
    expect(personaText).toContain('## Deliverables Contract (MANDATORY)');
    expect(personaText).toContain('deliverables/src/');
    expect(personaText).toContain('deliverables/tests/');
  });

  it('mandates the ls self-verify step before ending the turn', () => {
    expect(personaText).toContain('ls -la');
    expect(personaText.toLowerCase()).toContain('before ending your turn');
  });

  it('names a README/plan/handover-only turn as incomplete', () => {
    expect(personaText).toContain('INCOMPLETE turn');
  });
});
