/**
 * Live capture proof for the "Agent-Cluster Steps" competitive category.
 *
 * OSHAL's differentiator: a single workflow STEP fans out to a ranked CLUSTER of
 * cooperating agents (competing / reviewing roles), runs a review round, and applies
 * a quality GATE before the step is allowed to advance. This generator genuinely
 * exercises that control flow against the REAL orchestration code — no LLM calls:
 *
 *   Part A — Competency-ranked multi-round cluster (any-bot/server JS orchestrator):
 *     drives the real CompetencyRanker + PhaseRoundOrchestrator so one EXECUTION phase
 *     fans out to >1 ranked agent (primary executor + mandatory architect/tester review
 *     rounds) and only advances (PHASE_COMPLETE) once every review round completes.
 *
 *   Part B — Graph-engine fan-out + quality gate (TS ProcessDefinitionExecutionEngine):
 *     drives the real engine so one parallel-split step fans out concurrently to a
 *     cluster of two execute-agent nodes, then a verify-output QUALITY GATE routes the
 *     walk to deliver (advance) on PASS or escalate on FAIL. Run twice to capture the
 *     REAL gate decision in both directions.
 *
 * Agents are non-LLM stubs and Redis is an in-memory fake; the ranking, round, fan-out,
 * and gate CONTROL FLOW is the real shipped code. See the "Limits" section of the doc.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-agent-cluster-step-live.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProcessDefinitionExecutionEngine } from '@/features/workflow-studio/engine/process-definition-execution-engine';
import type { ProcessDefinition } from '@/features/workflow-studio/schemas/process-definition-schema';
import type { EngineExecutionResult, EngineStepTrace } from '@/features/workflow-studio/engine/process-definition-execution-engine';

// --- Date/timestamp helpers (copied exactly from the canonical templates) --------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// --- Shared check plumbing --------------------------------------------------------------

interface Check {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
}

function check(id: string, label: string, condition: unknown, evidence: string): Check {
  return { id, label, passed: Boolean(condition), evidence };
}

// --- In-memory fake Redis (async surface used by the JS PhaseRoundOrchestrator) --------

function createFakeRedis(): Record<string, unknown> {
  const store = new Map<string, string>();
  return {
    async set(key: string, value: string) { store.set(key, value); return 'OK'; },
    async get(key: string) { return store.has(key) ? store.get(key) : null; },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
  };
}

// --- Part A: competency-ranked multi-round cluster (real JS orchestrator) ----------------

interface ClusterResult {
  rankedAgents: Array<{ agentId: string; role: string; confidence: number }>;
  rounds: Array<{ round: number; agentId: string; role: string }>;
  actions: string[];
  finalState: string;
  checks: Check[];
}

/**
 * @description Load the real any-bot/server orchestrator classes. The winston logger they
 * require writes to any-bot/server/logs, so that directory is created first.
 * @returns The real CompetencyRanker and PhaseRoundOrchestrator constructors.
 */
function loadClusterModules(): { CompetencyRanker: any; PhaseRoundOrchestrator: any } {
  mkdirSync(path.join(process.cwd(), 'any-bot', 'server', 'logs'), { recursive: true });
  const base = '../../any-bot/server/services/queue-manager';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CompetencyRanker = require(`${base}/CompetencyRanker`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PhaseRoundOrchestrator } = require(`${base}/PhaseRoundOrchestrator`);
  return { CompetencyRanker: CompetencyRanker.CompetencyRanker || CompetencyRanker, PhaseRoundOrchestrator };
}

/**
 * @description Genuinely drive the real CompetencyRanker + PhaseRoundOrchestrator so a
 * single EXECUTION phase fans out to a ranked multi-agent cluster with mandatory review
 * rounds, then advance round-by-round to the quality-gated PHASE_COMPLETE outcome.
 * @returns Captured ranking, round fan-out, per-round advance actions, and assertions.
 */
async function runCluster(): Promise<ClusterResult> {
  const { CompetencyRanker, PhaseRoundOrchestrator } = loadClusterModules();
  const ranker = new CompetencyRanker({ meshBroadcast: null, agentRegistry: null, redis: createFakeRedis() });
  const orchestrator = new PhaseRoundOrchestrator({ redis: createFakeRedis(), defaultRounds: 2 });

  const ticket = { id: 'agent-cluster-proof-001', name: 'Build a gated /report endpoint' };
  const analysis = { capabilities: ['backend', 'node', 'api'], complexity: 'high', priority: 'high' };
  const agents = [
    { agent_id: 'backend-sme', capabilities: ['backend', 'node', 'api'] },
    { agent_id: 'architect-bot', capabilities: ['architecture', 'design'] },
    { agent_id: 'tester-bot', capabilities: ['testing', 'qa'] },
    { agent_id: 'frontend-sme', capabilities: ['frontend', 'ui'] },
    { agent_id: 'project-manager', capabilities: ['planning'] },
  ];
  const PHASE_EXECUTION = 4;

  const ranked = await ranker.rankAgentsForPhase(ticket, analysis, PHASE_EXECUTION, agents);
  const state = await orchestrator.initPhaseRounds(ticket.id, PHASE_EXECUTION, ranked);
  const rounds = state.rounds.map((r: any) => ({ round: r.round, agentId: r.agentId, role: r.role }));

  const actions: string[] = [];
  let finalState = state.state;
  for (let i = 0; i < state.maxRounds; i++) {
    const cur = await orchestrator.getCurrentRoundAgent(ticket.id, PHASE_EXECUTION);
    const outcome = await orchestrator.completeRound(ticket.id, PHASE_EXECUTION, cur.agentId, `round ${cur.round} work`, null);
    actions.push(outcome.action);
    finalState = outcome.state.state;
  }

  const distinctAgents = new Set(rounds.map((r: any) => r.agentId));
  const checks = [
    check('rank-ordered', 'CompetencyRanker returns an ordered cluster with the top domain SME first', ranked.length >= 3 && ranked[0].agentId === 'backend-sme', `${ranked.length} ranked; top=${ranked[0]?.agentId}(${ranked[0]?.role})`),
    check('fanout-multi-agent', 'The single EXECUTION step fans out to >1 distinct agent across rounds', state.maxRounds >= 2 && distinctAgents.size >= 3, `maxRounds=${state.maxRounds}, distinctAgents=${distinctAgents.size}`),
    check('mandatory-reviewers', 'Mandatory review roles (architect + tester) are injected into the cluster', distinctAgents.has('architect-bot') && distinctAgents.has('tester-bot'), rounds.map((r: any) => `R${r.round}:${r.agentId}(${r.role})`).join(', ')),
    check('review-round-advance', 'Each review round advances (NEXT_ROUND) before the gate lets the phase complete', actions.filter((a) => a === 'NEXT_ROUND').length >= 1 && actions[actions.length - 1] === 'PHASE_COMPLETE', `actions=${actions.join(' -> ')}`),
    check('gate-to-advance', 'Phase advances only after ALL rounds complete (round gate)', finalState === 'all_rounds_complete', `finalState=${finalState}`),
  ];
  return { rankedAgents: ranked.map((r: any) => ({ agentId: r.agentId, role: r.role, confidence: r.confidence })), rounds, actions, finalState, checks };
}

// --- Part B: graph-engine fan-out + quality gate (real TS engine) -----------------------

interface GateRun {
  testResult: boolean;
  outcome: string;
  success: boolean;
  decisionBranch: string | undefined;
  fanoutAgents: string[];
  gateNodePresent: boolean;
  terminalType: string | undefined;
  testPassed: unknown;
  trace: Array<{ nodeType: string; title: string; outcome: string }>;
}

/**
 * @description Build the fan-out + gate ProcessDefinition: start -> seed -> parallel-split
 * that fans out to two competing/reviewing execute-agent nodes -> parallel-join ->
 * verify-output QUALITY GATE -> logic-gate that routes to deliver (advance) or escalate.
 * @returns A ProcessDefinition consumable by the real engine.
 */
function buildFanoutGateGraph(): ProcessDefinition {
  const nodes = [
    { id: 'start', type: 'start', title: 'Start', config: {} },
    { id: 'seed', type: 'test-seed', title: 'Seed test verdict', config: {} },
    { id: 'split', type: 'parallel-split', title: 'Fan out to cluster', config: { joinNodeId: 'join' } },
    { id: 'execA', type: 'execute-agent', title: 'Reviewer Alpha (competing)', config: { agentId: 'reviewer-alpha', workType: 'implementation' } },
    { id: 'execB', type: 'execute-agent', title: 'Reviewer Beta (reviewing)', config: { agentId: 'reviewer-beta', workType: 'review' } },
    { id: 'join', type: 'parallel-join', title: 'Rejoin cluster', config: {} },
    { id: 'gate', type: 'verify-output', title: 'Quality gate (verify)', config: {} },
    { id: 'decision', type: 'logic-gate', title: 'Gate decision', config: { operator: 'expression', expression: 'testPassed === true', trueLabel: 'pass', falseLabel: 'fail' } },
    { id: 'deliver', type: 'deliver', title: 'Advance / deliver', config: {} },
    { id: 'escalate', type: 'escalate', title: 'Escalate', config: { target: 'ops', severity: 'high' } },
  ];
  const edges = [
    { source: 'start', target: 'seed' },
    { source: 'seed', target: 'split' },
    { source: 'split', target: 'execA', label: 'a' },
    { source: 'split', target: 'execB', label: 'b' },
    { source: 'execA', target: 'join' },
    { source: 'execB', target: 'join' },
    { source: 'join', target: 'gate' },
    { source: 'gate', target: 'decision' },
    { source: 'decision', target: 'deliver', label: 'pass' },
    { source: 'decision', target: 'escalate', label: 'fail' },
  ];
  return { nodeGraph: { nodes, edges } } as unknown as ProcessDefinition;
}

/**
 * @description Run the real ProcessDefinitionExecutionEngine over the fan-out + gate graph
 * and capture the genuine gate decision. A tiny 'test-seed' executor injects only the test
 * verdict input; the fan-out region, verify-output gate, logic-gate routing, and
 * deliver/escalate terminal are all the real engine.
 * @param seedTestResult - The verdict the quality gate evaluates.
 * @returns Captured outcome, fan-out agents, gate branch, and terminal node.
 */
async function runGraphGate(seedTestResult: boolean): Promise<GateRun> {
  const engine = new ProcessDefinitionExecutionEngine();
  engine.registerExecutor('test-seed', async () => ({ output: { seeded: true }, variables: { _testResult: seedTestResult } }));

  const graph = buildFanoutGateGraph();
  const result: EngineExecutionResult = await engine.execute(graph, { externalId: 'agent-cluster-graph-001', title: 'Gated cluster step' });

  const trace = result.trace.map((t: EngineStepTrace) => ({ nodeType: t.nodeType, title: t.title, outcome: t.outcome }));
  const fanoutAgents = result.trace.filter((t) => t.nodeType === 'execute-agent' && t.outcome === 'completed').map((t) => t.title);
  const decisionTrace = result.trace.find((t) => t.nodeType === 'logic-gate');
  const terminal = result.trace.find((t) => t.outcome === 'terminal');
  return {
    testResult: seedTestResult,
    outcome: result.outcome,
    success: result.success,
    decisionBranch: decisionTrace?.variables?._selectedBranch as string | undefined,
    fanoutAgents,
    gateNodePresent: result.trace.some((t) => t.nodeType === 'verify-output'),
    terminalType: terminal ? terminalTypeFor(terminal, graph) : undefined,
    testPassed: result.variables.testPassed,
    trace,
  };
}

function terminalTypeFor(terminal: EngineStepTrace, graph: ProcessDefinition): string {
  const node = graph.nodeGraph!.nodes.find((n: any) => n.id === terminal.nodeId) as any;
  return node ? node.type : 'unknown';
}

function gateChecks(pass: GateRun, fail: GateRun): Check[] {
  return [
    check('graph-fanout', 'One parallel-split step fans out concurrently to a 2-agent cluster', pass.fanoutAgents.length === 2, `agents=[${pass.fanoutAgents.join(', ')}]`),
    check('gate-node-runs', 'The verify-output quality gate node executes inside the graph walk', pass.gateNodePresent && fail.gateNodePresent, `gate present pass=${pass.gateNodePresent} fail=${fail.gateNodePresent}`),
    check('gate-pass-advances', 'Quality gate PASS routes the step to deliver/advance (outcome completed)', pass.outcome === 'completed' && pass.success === true && pass.decisionBranch === 'pass' && pass.terminalType === 'deliver', `outcome=${pass.outcome}, branch=${pass.decisionBranch}, terminal=${pass.terminalType}`),
    check('gate-fail-blocks', 'Quality gate FAIL blocks advance and escalates (outcome escalated)', fail.outcome === 'escalated' && fail.decisionBranch === 'fail' && fail.terminalType === 'escalate', `outcome=${fail.outcome}, branch=${fail.decisionBranch}, terminal=${fail.terminalType}`),
    check('gate-real-decision', 'The gate decision is driven by the real verdict variable (testPassed)', pass.testPassed === true && fail.testPassed === false, `pass.testPassed=${pass.testPassed}, fail.testPassed=${fail.testPassed}`),
  ];
}

// --- Markdown / JSON rendering ----------------------------------------------------------

function renderMarkdown(cluster: ClusterResult, pass: GateRun, fail: GateRun, allChecks: Check[], generatedAt: Date): string {
  const passCount = allChecks.filter((c) => c.passed).length;
  return [
    `# Agent-Cluster Step Fan-Out and Quality Gate - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - real orchestration code executed in-process against non-LLM agent stubs and an in-memory Redis; the ranking, round fan-out, and gate control flow is the shipped code.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    `Passed ${passCount}/${allChecks.length} assertions. One workflow step genuinely fans out to a ranked multi-agent **cluster** and a quality **gate** decides whether the step advances.`,
    '',
    '## Part A — Competency-ranked multi-round cluster (any-bot PhaseRoundOrchestrator)',
    '',
    'The real `CompetencyRanker` ranked the agents and the real `PhaseRoundOrchestrator` fanned the single EXECUTION',
    'step out across multiple rounds, injecting the mandatory architect + tester **review** roles into the cluster.',
    'The phase only advances (PHASE_COMPLETE) once every review round clears the round gate.',
    '',
    `- Ranked cluster: ${cluster.rankedAgents.map((a) => `${a.agentId}(${a.role}/${a.confidence.toFixed(2)})`).join(', ')}`,
    `- Round fan-out: ${cluster.rounds.map((r) => `R${r.round}:${r.agentId}(${r.role})`).join(', ')}`,
    `- Per-round advance actions: ${cluster.actions.join(' -> ')}`,
    `- Final phase state: ${cluster.finalState}`,
    '',
    '## Part B — Graph-engine fan-out + quality gate (ProcessDefinitionExecutionEngine)',
    '',
    'The real graph engine walked a `parallel-split` that fanned out concurrently to two competing/reviewing',
    '`execute-agent` nodes, rejoined, then applied a `verify-output` **quality gate**. The gate decision was',
    'captured in BOTH directions:',
    '',
    '| Run | Injected verdict | Fan-out agents | Gate branch | Terminal | Outcome |',
    '|---|---|---|---|---|---|',
    `| PASS | testPassed=true | ${pass.fanoutAgents.length} | ${pass.decisionBranch} | ${pass.terminalType} | ${pass.outcome} |`,
    `| FAIL | testPassed=false | ${fail.fanoutAgents.length} | ${fail.decisionBranch} | ${fail.terminalType} | ${fail.outcome} |`,
    '',
    'PASS trace:',
    '',
    '```json',
    JSON.stringify(pass.trace, null, 2),
    '```',
    '',
    'FAIL trace:',
    '',
    '```json',
    JSON.stringify(fail.trace, null, 2),
    '```',
    '',
    '## Assertions',
    '',
    '| Check | Evidence | Result |',
    '|---|---|---|',
    ...allChecks.map((c) => `| ${c.label} | ${c.evidence} | ${c.passed ? 'pass' : 'fail'} |`),
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-agent-cluster-step-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'This is an integration-tier capture of the real orchestration control flow, not a full LLM-backed swarm run:',
    '',
    '- **Genuinely live/real:** the shipped `CompetencyRanker`, `PhaseRoundOrchestrator`, and',
    '  `ProcessDefinitionExecutionEngine` code executes in-process. Ranking, round assignment with mandatory',
    '  reviewer injection, per-round advancement, the concurrent parallel fan-out region, the verify-output',
    '  quality gate, logic-gate branch routing, and the deliver/escalate terminal decision are all real code.',
    '- **Stubbed:** the cluster agents are non-LLM stubs (no model call, no cost). Part A uses an in-memory fake',
    '  Redis in place of the container Redis. Part B runs the engine in stub mode (no wired EngineServices), and',
    '  a tiny `test-seed` node injects ONLY the gate\'s input verdict — the gate\'s decision logic itself is',
    '  unmodified engine code. Postgres, auth/OIDC, and the live bot-node HTTP dispatch are not exercised here.',
    '- A full LLM-backed end-to-end run additionally requires Postgres, seeded persona/agent data, and a',
    '  resolvable provider on the bot nodes (see docs/architecture/swarm-processing-design-contract.md).',
    '',
  ].join('\n');
}

// --- Main -------------------------------------------------------------------------------

async function main(): Promise<void> {
  const cluster = await runCluster();
  const pass = await runGraphGate(true);
  const fail = await runGraphGate(false);
  const allChecks = [...cluster.checks, ...gateChecks(pass, fail)];

  const failed = allChecks.filter((c) => !c.passed);
  if (failed.length) {
    console.error(JSON.stringify({ ok: false, failed }, null, 2));
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date();
  const outDir = path.join(process.cwd(), 'docs', 'evidence');
  mkdirSync(outDir, { recursive: true });
  const basename = `agent-cluster-step-${dateStamp(generatedAt)}`;
  const mdPath = path.join(outDir, `${basename}.md`);
  const jsonPath = path.join(outDir, `${basename}.json`);
  writeFileSync(mdPath, renderMarkdown(cluster, pass, fail, allChecks, generatedAt), 'utf8');
  writeFileSync(jsonPath, JSON.stringify({
    proofTier: 'live',
    generatedAt: generatedAt.toISOString(),
    category: 'agent-cluster-steps',
    cluster,
    graphGate: { pass, fail },
    checks: allChecks,
    passed: allChecks.length,
    total: allChecks.length,
  }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, mdPath, jsonPath, passed: allChecks.length, total: allChecks.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
