/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | System default ProcessDefinition — encodes the existing hardcoded 7-phase loop as a graph
 */

import { randomUUID } from 'node:crypto';
import type { ProcessDefinition } from '../schemas/process-definition-schema';

/**
 * Builds the system default ProcessDefinition that encodes the exact same
 * behavior as the hardcoded processOneTicket() loop.
 *
 * This is the FIRST test case of the general framework. If the engine cannot
 * replicate the existing loop by running this definition, the framework is broken.
 *
 * Graph structure:
 *   start → intake → planner → gate:stopAfterPlanning?
 *     → true: deliver-plan-only
 *     → false: gate:complexity>=high?
 *       → true: specialist → execute
 *       → false: execute
 *     execute → gate:complexity>=medium?
 *       → true: verify-output → gate:testPassed?
 *         → true: gate:complexity>=high?
 *           → true: review → gate:reviewPassed?
 *             → true: deliver
 *             → false: execute (regression)
 *           → false: deliver
 *         → false: execute (regression)
 *       → false: gate:complexity>=high?  (skip testing, check review)
 *         → true: review → gate:reviewPassed?
 *           → true: deliver
 *           → false: execute (regression)
 *         → false: deliver
 */
export function buildSystemDefaultProcessDefinition(): ProcessDefinition {
  // Stable IDs for the system default
  const N = {
    start: 'sys-start',
    intake: 'sys-intake',
    planner: 'sys-planner',
    gateStop: 'sys-gate-stop-after-planning',
    deliverPlan: 'sys-deliver-plan-only',
    gateHigh1: 'sys-gate-complexity-high-specialist',
    specialist: 'sys-specialist-input',
    execute: 'sys-execute-agent',
    gateMedTest: 'sys-gate-complexity-med-testing',
    verify: 'sys-verify-output',
    gateTestPass: 'sys-gate-test-passed',
    gateHigh2: 'sys-gate-complexity-high-review',
    review: 'sys-review',
    gateReviewPass: 'sys-gate-review-passed',
    deliver: 'sys-deliver',
    escalate: 'sys-escalate',
  };

  const nodes = [
    { id: N.start, type: 'start', title: 'Start', config: { triggerMode: 'manual', maxRegressionLoops: 3, maxVerificationAttempts: 3, maxRunDurationMs: 1_800_000, escalationTarget: 'human_review', escalationSeverity: 'high' } },
    { id: N.intake, type: 'intake-source', title: 'Intake & Complexity Score', config: { provider: 'direct', interactionMode: 'ticket' } },
    { id: N.planner, type: 'planner', title: 'PM Planning', config: { planningMode: 'pm-planning', stopAfterPlanning: true, architecturePreRound: false, requireTechnicalSpec: false, requireImplementationPlan: false } },
    { id: N.gateStop, type: 'logic-gate', title: 'Stop After Planning?', config: { operator: 'expression', expression: 'stopAfterPlanning === true', trueLabel: 'yes-stop', falseLabel: 'continue' } },
    { id: N.deliverPlan, type: 'deliver', title: 'Deliver Planning Result', config: { deliveryMode: 'planning-only' } },
    { id: N.gateHigh1, type: 'logic-gate', title: 'Complexity >= High?', config: { operator: 'expression', expression: "complexity_gte('high')", trueLabel: 'high', falseLabel: 'skip-specialist' } },
    { id: N.specialist, type: 'route-agent', title: 'Specialist Input', config: { phase: 'specialist_input', selectionMode: 'phase-router' } },
    { id: N.execute, type: 'execute-agent', title: 'Execute Work', config: { agentBinding: 'routed-agent', workType: 'implementation', primaryRole: 'executor', reviewerRole: 'code-improver', roundCount: 2 } },
    { id: N.gateMedTest, type: 'logic-gate', title: 'Complexity >= Medium?', config: { operator: 'expression', expression: "complexity_gte('medium')", trueLabel: 'test', falseLabel: 'skip-testing' } },
    { id: N.verify, type: 'verify-output', title: 'Verify Output', config: { evidenceClass: 'implementation', maxAttempts: 3, regressionTarget: 'execution' } },
    { id: N.gateTestPass, type: 'logic-gate', title: 'Test Passed?', config: { operator: 'expression', expression: 'testPassed === true', trueLabel: 'passed', falseLabel: 'regress' } },
    { id: N.gateHigh2, type: 'logic-gate', title: 'Complexity >= High? (Review)', config: { operator: 'expression', expression: "complexity_gte('high')", trueLabel: 'review', falseLabel: 'skip-review' } },
    { id: N.review, type: 'review', title: 'Review Outcome', config: { reviewerRole: 'code-reviewer', consensusMode: 'single-reviewer', regressionTarget: 'execution' } },
    { id: N.gateReviewPass, type: 'logic-gate', title: 'Review Passed?', config: { operator: 'expression', expression: 'reviewPassed === true', trueLabel: 'passed', falseLabel: 'regress' } },
    { id: N.deliver, type: 'deliver', title: 'Deliver Result', config: { deliveryMode: 'ticket-writeback' } },
    { id: N.escalate, type: 'escalate', title: 'Escalate', config: { target: 'human_review', severity: 'high' } },
  ];

  const edges = [
    { id: 'e-start-intake', source: N.start, target: N.intake },
    { id: 'e-intake-planner', source: N.intake, target: N.planner },
    { id: 'e-planner-gate-stop', source: N.planner, target: N.gateStop },
    { id: 'e-gate-stop-deliver-plan', source: N.gateStop, target: N.deliverPlan, label: 'yes-stop' },
    { id: 'e-gate-stop-continue', source: N.gateStop, target: N.gateHigh1, label: 'continue' },
    { id: 'e-gate-high1-specialist', source: N.gateHigh1, target: N.specialist, label: 'high' },
    { id: 'e-gate-high1-execute', source: N.gateHigh1, target: N.execute, label: 'skip-specialist' },
    { id: 'e-specialist-execute', source: N.specialist, target: N.execute },
    { id: 'e-execute-gate-med', source: N.execute, target: N.gateMedTest },
    { id: 'e-gate-med-verify', source: N.gateMedTest, target: N.verify, label: 'test' },
    { id: 'e-gate-med-skip', source: N.gateMedTest, target: N.gateHigh2, label: 'skip-testing' },
    { id: 'e-verify-gate-test', source: N.verify, target: N.gateTestPass },
    { id: 'e-gate-test-passed', source: N.gateTestPass, target: N.gateHigh2, label: 'passed' },
    { id: 'e-gate-test-regress', source: N.gateTestPass, target: N.execute, label: 'regress' },
    { id: 'e-gate-high2-review', source: N.gateHigh2, target: N.review, label: 'review' },
    { id: 'e-gate-high2-deliver', source: N.gateHigh2, target: N.deliver, label: 'skip-review' },
    { id: 'e-review-gate-review', source: N.review, target: N.gateReviewPass },
    { id: 'e-gate-review-passed', source: N.gateReviewPass, target: N.deliver, label: 'passed' },
    { id: 'e-gate-review-regress', source: N.gateReviewPass, target: N.execute, label: 'regress' },
  ];

  const topologicalOrder = [
    N.start, N.intake, N.planner, N.gateStop, N.deliverPlan,
    N.gateHigh1, N.specialist, N.execute, N.gateMedTest,
    N.verify, N.gateTestPass, N.gateHigh2, N.review,
    N.gateReviewPass, N.deliver, N.escalate,
  ];

  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    definitionId: 'a0000000-0000-4000-8000-000000000001',
    definitionVersion: 1,
    schemaVersion: 1,
    name: 'System Default — 7-Phase Swarm Pipeline',
    compiledAt: now,
    status: 'draft',
    phaseSequence: [
      { phase: 'intake', enabled: true, sourceNodeId: N.intake },
      { phase: 'planning', enabled: true, sourceNodeId: N.planner },
      { phase: 'specialist_input', enabled: true, complexityThreshold: 'high', sourceNodeId: N.specialist },
      { phase: 'execution', enabled: true, sourceNodeId: N.execute },
      { phase: 'testing', enabled: true, complexityThreshold: 'medium', sourceNodeId: N.verify },
      { phase: 'review', enabled: true, complexityThreshold: 'high', sourceNodeId: N.review },
      { phase: 'delivery', enabled: true, sourceNodeId: N.deliver },
    ],
    roundStructure: {
      execution: { phase: 'execution', rounds: [{ round: 1, role: 'executor', agentBinding: 'routed-agent', requiredCapabilities: [] }, { round: 2, role: 'code-improver', agentBinding: 'routed-agent', requiredCapabilities: [] }] },
      planning: { phase: 'planning', rounds: [{ round: 1, role: 'architect', agentBinding: 'routed-agent', requiredCapabilities: [] }, { round: 2, role: 'plan-reviewer', agentBinding: 'routed-agent', requiredCapabilities: [] }] },
      testing: { phase: 'testing', rounds: [{ round: 1, role: 'tester', agentBinding: 'routed-agent', requiredCapabilities: [] }, { round: 2, role: 'qa-verifier', agentBinding: 'routed-agent', requiredCapabilities: [] }] },
      review: { phase: 'review', rounds: [{ round: 1, role: 'qa-gatekeeper', agentBinding: 'routed-agent', requiredCapabilities: [] }, { round: 2, role: 'domain-specialist-review', agentBinding: 'routed-agent', requiredCapabilities: [] }] },
    },
    routingPreferences: {},
    retryPolicy: {
      maxVerificationAttempts: 3,
      maxBuildRegressions: 1,
      maxDesignRegressions: 1,
      maxWritebackAttempts: 2,
      maxTotalCycles: 15,
      maxRunDurationMs: 1_800_000,
      maxPhaseRegressions: 3,
      escalationTarget: 'human_review',
      escalationSeverity: 'high',
    },
    handoverRequirements: {},
    planningConfig: {
      planningMode: 'pm-planning',
      stopAfterPlanning: true,
      architecturePreRound: false,
      artifactGates: { technicalSpecification: false, implementationPlan: false },
    },
    edgeConditions: [],
    nodeRetryConfig: {},
    errorBranches: [],
    stepOutputBindings: [],
    nodeGraph: {
      nodes,
      edges,
      topologicalOrder,
    },
  };
}
