/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ProcessDefinitionExecutionEngine — general-purpose graph walker that executes any ProcessDefinition
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Real parallel-split/join fan-out (concurrent; escalate on branch failure); ai-decision dispatches to a bot; durable/resumable execution (ExecuteOptions.resumeState + onCheckpoint before each node); agent-cluster node executor (ranked cluster + reviewer gate).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ExecuteOptions.onStep observer: emits one EngineStepEvent per executed node (timing, input variables, output, agent) so the dispatch worker can persist run history. Guarded (emitStep catches) so an observer failure can never break a run; threaded through parallel regions.
 */

import { createChildLogger } from '@/shared/logger';
import type { ProcessDefinition, ExecutableNode, ExecutableEdge } from '../schemas/process-definition-schema';
import type { EngineState, EngineStateSnapshot } from './engine-state';
import { createEngineState, snapshotEngineState, applyEngineSnapshot } from './engine-state';
import { evaluateLogicGate } from './expression-evaluator';
import type { EngineServices, EngineTicketContext } from './engine-services';
import { randomUUID } from 'node:crypto';

const logger = createChildLogger({ module: 'process-definition-engine' });

const MAX_STEPS = 200; // Safety cap to prevent infinite loops
const TERMINAL_NODE_TYPES = new Set(['deliver', 'escalate']);

/**
 * Result returned by a node executor after processing one node.
 */
export interface NodeExecutionResult {
  /** Output data from this node (stored in state.nodeOutputs) */
  output: unknown;
  /** Variables to merge into state.variables for downstream branch resolution */
  variables?: Record<string, unknown>;
  /** If set, jump to this nodeId instead of following edges (regression loop-back) */
  jumpTo?: string;
  /** If true, engine should terminate and return this result */
  terminate?: boolean;
  /** If true, engine should SUSPEND here (e.g. a human approval gate) and return an
   *  'suspended' outcome with the node to resume at. The caller persists the resume
   *  point and re-invokes execute(def, ticket, resumeNodeId) once approved. */
  suspend?: boolean;
  /** Terminal result payload */
  terminalResult?: Record<string, unknown>;
}

/**
 * Function signature for a node executor.
 * Each node type has a registered executor that calls the appropriate existing service.
 */
export type NodeExecutor = (
  state: EngineState,
  node: ExecutableNode,
  engine: ProcessDefinitionExecutionEngine,
) => Promise<NodeExecutionResult>;

/** Options for durable/resumable execution. */
export interface ExecuteOptions {
  /** Restore accumulated state from a prior run (crash/restart/suspend) so already-completed nodes
   *  are not re-executed. Applied only when resumeFromNodeId points to a node still in the graph. */
  resumeState?: EngineStateSnapshot;
  /** Persist a durable checkpoint BEFORE each node runs: (resumeNodeId, state snapshot of prior
   *  completed nodes). Awaited so the checkpoint is durable before the node executes; a crash then
   *  resumes by re-running only that one in-flight node. Must be non-throwing. */
  onCheckpoint?: (resumeNodeId: string, snapshot: EngineStateSnapshot) => Promise<void> | void;
  /** Observe each executed node (run-history recording): timing, the variables visible when the
   *  node started (input), the executor's output, and the dispatched agent when one ran. Emitted
   *  for main-walk AND parallel-branch nodes. The engine guards the call (emitStep catches), so an
   *  observer failure can never break a run — implementations should still be non-throwing. */
  onStep?: (event: EngineStepEvent) => Promise<void> | void;
}

/** One executed node as observed via ExecuteOptions.onStep. */
export interface EngineStepEvent {
  nodeId: string;
  nodeType: string;
  title: string;
  outcome: 'completed' | 'terminal' | 'jump' | 'skipped' | 'escalated' | 'suspended';
  /** Epoch ms when the node started executing. */
  startedAt: number;
  /** Epoch ms when the node finished (event emit time). */
  finishedAt: number;
  /** The variables visible when the node started (its effective input). */
  input?: Record<string, unknown>;
  /** The node executor's output payload. */
  output?: unknown;
  /** The agent that executed the node, when one was dispatched. */
  agentId?: string;
}

/**
 * General-purpose execution engine that walks a ProcessDefinition's node graph,
 * calling existing swarm services as primitives at each node.
 *
 * This is a SEPARATE execution path from the hardcoded processOneTicket() loop.
 * The existing loop remains untouched as the fallback when no ProcessDefinition is active.
 */
export class ProcessDefinitionExecutionEngine {
  private readonly executors = new Map<string, NodeExecutor>();
  private services?: EngineServices;

  constructor(services?: EngineServices) {
    this.services = services;
    // Register default node executors
    this.registerExecutor('start', executeStartNode);
    this.registerExecutor('intake-source', executeIntakeNode);
    this.registerExecutor('planner', executePlannerNode);
    this.registerExecutor('logic-gate', executeLogicGateNode);
    this.registerExecutor('route-agent', executeRouteAgentNode);
    this.registerExecutor('execute-agent', executeExecuteAgentNode);
    this.registerExecutor('verify-output', executeVerifyOutputNode);
    this.registerExecutor('review', executeReviewNode);
    this.registerExecutor('deliver', executeDeliverNode);
    this.registerExecutor('escalate', executeEscalateNode);
    this.registerExecutor('approval-gate', executeApprovalGateNode);
    this.registerExecutor('parallel-split', executePassthroughNode);
    this.registerExecutor('parallel-join', executePassthroughNode);
    this.registerExecutor('ai-decision', executeAiDecisionNode);
    this.registerExecutor('agent-cluster', executeAgentClusterNode);
    this.registerExecutor('sub-process', executeSubProcessNode);
  }

  /**
   * Register or override a node executor for a given node type.
   */
  registerExecutor(nodeType: string, executor: NodeExecutor): void {
    this.executors.set(nodeType, executor);
  }

  /** Get the wired services (null in test mode). */
  getServices(): EngineServices | undefined {
    return this.services;
  }

  /** Build a ticket context from engine state for service calls. */
  buildTicketContext(state: EngineState): EngineTicketContext {
    const ticket = state.ticket ?? {};
    return {
      externalId: String(ticket.externalId ?? ticket.ticketId ?? state.runId),
      title: String(ticket.title ?? 'Engine Ticket'),
      body: ticket.body as string | undefined,
      labels: (ticket.labels as string[]) ?? [],
      provider: String(ticket.provider ?? 'direct'),
      parentExternalId: ticket.parentExternalId as string | undefined,
      depth: Number(ticket.depth ?? 0),
      raw: ticket,
    };
  }

  /**
   * Execute a ProcessDefinition by walking its node graph.
   *
   * @param processDefinition - The compiled ProcessDefinition with nodeGraph
   * @returns Engine execution result with step trace and terminal output
   */
  async execute(
    processDefinition: ProcessDefinition,
    ticket?: Record<string, unknown>,
    resumeFromNodeId?: string,
    opts?: ExecuteOptions,
  ): Promise<EngineExecutionResult> {
    const graph = processDefinition.nodeGraph;
    if (!graph) {
      throw new Error('ProcessDefinition has no nodeGraph — cannot execute');
    }

    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const outgoingEdges = new Map<string, ExecutableEdge[]>();
    for (const edge of graph.edges) {
      const existing = outgoingEdges.get(edge.source) ?? [];
      existing.push(edge);
      outgoingEdges.set(edge.source, existing);
    }

    // Find start node
    const startNode = graph.nodes.find((n) => n.type === 'start');
    if (!startNode) {
      throw new Error('ProcessDefinition nodeGraph has no start node');
    }

    const state = createEngineState(randomUUID(), '', ticket);
    // Read global config from start node
    const maxLoops = Number(startNode.config.maxRegressionLoops);
    if (Number.isFinite(maxLoops) && maxLoops > 0) {
      state.maxRegressionLoops = maxLoops;
    }

    const trace: EngineStepTrace[] = [];
    // Resume when a valid resume node is supplied (approval-gate suspend OR a crash/restart
    // checkpoint); otherwise start from the beginning. On resume we restore the accumulated state
    // from the checkpoint so already-completed nodes are NOT re-executed.
    const resuming = Boolean(resumeFromNodeId && nodeMap.has(resumeFromNodeId));
    if (resuming && opts?.resumeState) {
      applyEngineSnapshot(state, opts.resumeState);
      logger.info({ resumeFromNodeId, restoredVars: Object.keys(opts.resumeState.variables ?? {}).length }, 'Resuming graph execution from checkpoint');
    }
    let currentNodeId: string | null =
      resuming ? (resumeFromNodeId as string) : startNode.id;
    let stepCount = 0;

    while (currentNodeId && stepCount < MAX_STEPS) {
      stepCount++;
      const node = nodeMap.get(currentNodeId);
      if (!node) {
        logger.error({ currentNodeId }, 'Node not found in graph');
        break;
      }

      // Durable checkpoint: persist "about to execute currentNodeId" + the accumulated state of all
      // prior completed nodes, so a crash/restart resumes by re-running only this in-flight node
      // rather than the whole graph. Skip the trivial start node (nothing to save, free to re-run).
      if (opts?.onCheckpoint && node.type !== 'start') {
        await opts.onCheckpoint(currentNodeId, snapshotEngineState(state));
      }

      // Run-history observation: the node's effective input is the variables visible now.
      const stepStartedAt = Date.now();
      const stepInput = opts?.onStep ? { ...state.variables } : undefined;

      // Track visits for regression detection
      const visitCount = (state.visitCounts.get(currentNodeId) ?? 0) + 1;
      state.visitCounts.set(currentNodeId, visitCount);

      // Check regression budget on re-visited execution nodes
      if (visitCount > 1 && (node.type === 'execute-agent' || node.type === 'agent-cluster')) {
        state.regressionLoopCount++;
        logger.info(
          { nodeId: currentNodeId, regressionLoop: state.regressionLoopCount, max: state.maxRegressionLoops },
          'Regression loop detected — re-visiting execution node',
        );
        if (state.regressionLoopCount > state.maxRegressionLoops) {
          logger.warn({ nodeId: currentNodeId }, 'Regression budget exhausted — escalating');
          trace.push({ nodeId: currentNodeId, nodeType: node.type, title: node.title, outcome: 'escalated', variables: { ...state.variables } });
          await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput);
          return {
            success: false,
            outcome: 'escalated',
            reason: `Regression budget exhausted after ${state.regressionLoopCount} loops`,
            trace,
            variables: state.variables,
          };
        }
      }

      // Execute the node
      const executor = this.executors.get(node.type);
      if (!executor) {
        logger.warn({ nodeType: node.type, nodeId: currentNodeId }, 'No executor registered for node type');
        trace.push({ nodeId: currentNodeId, nodeType: node.type, title: node.title, outcome: 'skipped' });
        await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput);
        currentNodeId = this.resolveNextNode(currentNodeId, state, outgoingEdges, nodeMap);
        continue;
      }

      logger.info({ nodeId: currentNodeId, nodeType: node.type, title: node.title, step: stepCount }, 'Executing node');

      const result = await executor(state, node, this);
      state.nodeOutputs.set(currentNodeId, result.output);
      if (result.variables) {
        Object.assign(state.variables, result.variables);
      }

      // Suspend (e.g. human approval gate): stop here and tell the caller where to resume.
      if (result.suspend) {
        const resumeNodeId = this.resolveNextNode(currentNodeId, state, outgoingEdges, nodeMap) ?? undefined;
        // Checkpoint PAST the gate so operator approval resumes at the successor WITH the state
        // accumulated before the gate (fixes the prior reset-to-empty-state on gate resume).
        if (opts?.onCheckpoint && resumeNodeId) {
          await opts.onCheckpoint(resumeNodeId, snapshotEngineState(state));
        }
        trace.push({ nodeId: currentNodeId, nodeType: node.type, title: node.title, outcome: 'suspended', variables: { ...state.variables } });
        await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput, result.output);
        return {
          success: false,
          outcome: 'suspended',
          reason: `Awaiting approval at: ${node.title}`,
          trace,
          variables: state.variables,
          resumeNodeId,
        };
      }

      trace.push({
        nodeId: currentNodeId,
        nodeType: node.type,
        title: node.title,
        outcome: result.terminate ? 'terminal' : result.jumpTo ? 'jump' : 'completed',
        variables: { ...state.variables },
      });
      await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput, result.output);

      // Terminal nodes end execution
      if (result.terminate || TERMINAL_NODE_TYPES.has(node.type)) {
        const declaredOutcome = typeof result.terminalResult?.outcome === 'string'
          ? result.terminalResult.outcome
          : undefined;
        const terminalOutcome = declaredOutcome === 'escalated'
          ? 'escalated'
          : node.type === 'escalate'
            ? 'escalated'
            : 'completed';
        return {
          success: terminalOutcome === 'completed' && node.type === 'deliver',
          outcome: terminalOutcome,
          reason: `Reached terminal node: ${node.title}`,
          trace,
          variables: state.variables,
          terminalResult: result.terminalResult,
        };
      }

      // Jump (regression loop-back)
      if (result.jumpTo) {
        currentNodeId = result.jumpTo;
        continue;
      }

      // A parallel-split fans out: run EVERY outgoing branch to the matching join, then continue
      // from the join. (Without this, resolveNextNode would follow a single edge and the other
      // branches would silently never run.) Branches share engine state; join is the merge point.
      if (node.type === 'parallel-split') {
        const joinId = await this.runParallelRegion(currentNodeId, state, outgoingEdges, nodeMap, trace, opts);
        // If any branch's bot dispatch failed (or the branch threw), the fan-out result is
        // incomplete — escalate the whole workflow rather than falsely reporting completion.
        if (state.variables._parallelBranchFailed) {
          trace.push({ nodeId: currentNodeId, nodeType: node.type, title: node.title, outcome: 'escalated', variables: { ...state.variables } });
          await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput);
          return {
            success: false,
            outcome: 'escalated',
            reason: 'A parallel branch failed to complete',
            trace,
            variables: state.variables,
          };
        }
        currentNodeId = joinId;
        continue;
      }

      // Follow edges to next node
      currentNodeId = this.resolveNextNode(currentNodeId, state, outgoingEdges, nodeMap);
    }

    if (stepCount >= MAX_STEPS) {
      logger.error({ stepCount }, 'Engine exceeded max step count — terminating');
      return {
        success: false,
        outcome: 'error',
        reason: `Exceeded maximum step count (${MAX_STEPS})`,
        trace,
        variables: state.variables,
      };
    }

    return {
      success: true,
      outcome: 'completed',
      reason: 'Graph walk completed (no more edges)',
      trace,
      variables: state.variables,
    };
  }

  /**
   * Resolve the next node by evaluating outgoing edges.
   * For logic-gate nodes, the executor already set a `_selectedBranch` variable
   * that matches an edge label.
   */
  private resolveNextNode(
    currentNodeId: string,
    state: EngineState,
    outgoingEdges: Map<string, ExecutableEdge[]>,
    nodeMap: Map<string, ExecutableNode>,
  ): string | null {
    const edges = outgoingEdges.get(currentNodeId);
    if (!edges || edges.length === 0) {
      return null;
    }

    // Single outgoing edge — follow it
    if (edges.length === 1) {
      return edges[0].target;
    }

    // Multiple edges — match by label against _selectedBranch
    const selectedBranch = state.variables._selectedBranch as string | undefined;
    if (selectedBranch) {
      const match = edges.find((e) => e.label === selectedBranch);
      if (match) {
        // Clear the selection for the next decision point
        delete state.variables._selectedBranch;
        return match.target;
      }
    }

    // Fallback: follow the first edge
    logger.warn(
      { currentNodeId, edgeCount: edges.length, selectedBranch },
      'Could not resolve branch — falling back to first edge',
    );
    return edges[0].target;
  }

  /**
   * Run a parallel region: execute every branch out of a parallel-split until each reaches the
   * matching parallel-join, then return the join id so the main walk continues past it. Branches
   * run CONCURRENTLY (their execute-agent nodes dispatch to their bots in parallel — real
   * wall-clock fan-out), and the region awaits them all before continuing past the join. A branch
   * that throws is isolated (allSettled) so it can't crash its siblings; failures are logged.
   * Branches share engine state (node outputs are keyed by node id, so they don't collide).
   * Approval gates and terminal nodes inside a parallel branch are not supported (rejected at
   * compile) — if one is reached anyway the branch stops there rather than corrupting the walk.
   *
   * @returns the join node id to continue from, or null if no join exists (region ends the walk)
   */
  private async runParallelRegion(
    splitNodeId: string,
    state: EngineState,
    outgoingEdges: Map<string, ExecutableEdge[]>,
    nodeMap: Map<string, ExecutableNode>,
    trace: EngineStepTrace[],
    opts?: ExecuteOptions,
  ): Promise<string | null> {
    const split = nodeMap.get(splitNodeId);
    const joinId = this.findParallelJoin(splitNodeId, split, outgoingEdges, nodeMap);
    const branchEdges = outgoingEdges.get(splitNodeId) ?? [];
    logger.info(
      { splitNodeId, joinId, branchCount: branchEdges.length },
      'Entering parallel region — fanning out all branches concurrently',
    );
    const settled = await Promise.allSettled(
      branchEdges.map((edge) => this.walkBranch(edge.target, joinId, state, outgoingEdges, nodeMap, trace, opts)),
    );
    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        logger.error({ splitNodeId, branch: branchEdges[i]?.target, err: String(outcome.reason) }, 'Parallel branch threw — siblings unaffected');
        state.variables._parallelBranchFailed = true;
      }
    });
    return joinId;
  }

  /**
   * Walk one parallel branch from `fromNodeId` until it reaches `joinNodeId` (exclusive),
   * a dead end, or the step cap. Reuses the registered executors + branch resolution, and
   * recurses for nested parallel-splits. Suspend/terminal nodes stop the branch (unsupported here).
   */
  private async walkBranch(
    fromNodeId: string,
    joinNodeId: string | null,
    state: EngineState,
    outgoingEdges: Map<string, ExecutableEdge[]>,
    nodeMap: Map<string, ExecutableNode>,
    trace: EngineStepTrace[],
    opts?: ExecuteOptions,
  ): Promise<void> {
    let cur: string | null = fromNodeId;
    let steps = 0;
    while (cur && cur !== joinNodeId && steps < MAX_STEPS) {
      steps++;
      const node = nodeMap.get(cur);
      if (!node) break;

      if (node.type === 'parallel-split') {
        cur = await this.runParallelRegion(cur, state, outgoingEdges, nodeMap, trace, opts);
        continue;
      }

      const stepStartedAt = Date.now();
      const stepInput = opts?.onStep ? { ...state.variables } : undefined;
      const executor = this.executors.get(node.type);
      if (!executor) {
        trace.push({ nodeId: cur, nodeType: node.type, title: node.title, outcome: 'skipped' });
        await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput);
        cur = this.resolveNextNode(cur, state, outgoingEdges, nodeMap);
        continue;
      }

      const result = await executor(state, node, this);
      state.nodeOutputs.set(cur, result.output);
      if (result.variables) {
        Object.assign(state.variables, result.variables);
      }

      if (result.suspend || result.terminate || TERMINAL_NODE_TYPES.has(node.type)) {
        const outcome = result.suspend && !result.terminate ? 'suspended' : 'terminal';
        trace.push({ nodeId: cur, nodeType: node.type, title: node.title, outcome });
        await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput, result.output);
        // A failure-terminal inside a branch (e.g. execute-agent dispatch failed → escalated)
        // marks the whole fan-out as failed; an unsupported terminal node just stops the branch.
        if (result.terminate && result.terminalResult?.outcome === 'escalated') {
          state.variables._parallelBranchFailed = true;
          logger.warn({ nodeId: cur, nodeType: node.type }, 'Parallel branch failed — workflow will escalate');
        } else {
          logger.warn(
            { nodeId: cur, nodeType: node.type },
            'Terminal/approval node inside a parallel branch is unsupported — stopping this branch',
          );
        }
        return;
      }

      trace.push({
        nodeId: cur,
        nodeType: node.type,
        title: node.title,
        outcome: result.jumpTo ? 'jump' : 'completed',
        variables: { ...state.variables },
      });
      await this.emitStep(opts, trace[trace.length - 1], stepStartedAt, stepInput, result.output);
      cur = result.jumpTo ?? this.resolveNextNode(cur, state, outgoingEdges, nodeMap);
    }
  }

  /**
   * @description Emit one EngineStepEvent to the optional onStep observer. Guarded: an observer
   * failure is logged and swallowed so run-history recording can never break a live run. The
   * dispatched agent is derived from the executor output (agentId) or the selectedAgentId variable.
   * @param opts - execute options (may be undefined / observer-less)
   * @param entry - the trace entry just pushed for this node
   * @param startedAt - epoch ms when the node started executing
   * @param input - the variables visible when the node started
   * @param output - the node executor's output payload (absent for skipped/escalated entries)
   * @returns resolves always
   */
  private async emitStep(
    opts: ExecuteOptions | undefined,
    entry: EngineStepTrace,
    startedAt: number,
    input?: Record<string, unknown>,
    output?: unknown,
  ): Promise<void> {
    if (!opts?.onStep) return;
    try {
      const out = output && typeof output === 'object' ? (output as Record<string, unknown>) : undefined;
      const fromOutput = typeof out?.agentId === 'string' ? (out.agentId as string) : undefined;
      const fromVars = typeof entry.variables?.selectedAgentId === 'string'
        ? (entry.variables.selectedAgentId as string)
        : undefined;
      await opts.onStep({
        nodeId: entry.nodeId,
        nodeType: entry.nodeType,
        title: entry.title,
        outcome: entry.outcome,
        startedAt,
        finishedAt: Date.now(),
        input,
        output,
        agentId: fromOutput ?? fromVars,
      });
    } catch (error) {
      logger.warn({ err: error, nodeId: entry.nodeId }, 'onStep observer failed — run continues unrecorded for this step');
    }
  }

  /**
   * Find the parallel-join that closes a parallel-split: an explicit `config.joinNodeId` wins;
   * otherwise BFS forward from the split and return the nearest reachable parallel-join (so nested
   * splits pair with their own inner join first). Returns null if none — the region just ends.
   */
  private findParallelJoin(
    splitNodeId: string,
    split: ExecutableNode | undefined,
    outgoingEdges: Map<string, ExecutableEdge[]>,
    nodeMap: Map<string, ExecutableNode>,
  ): string | null {
    const pinned = split?.config?.joinNodeId;
    if (typeof pinned === 'string' && nodeMap.get(pinned)?.type === 'parallel-join') {
      return pinned;
    }
    const queue: string[] = (outgoingEdges.get(splitNodeId) ?? []).map((e) => e.target);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodeMap.get(id);
      if (!node) continue;
      if (node.type === 'parallel-join') return id;
      for (const e of outgoingEdges.get(id) ?? []) queue.push(e.target);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine Execution Result
// ---------------------------------------------------------------------------

export interface EngineStepTrace {
  nodeId: string;
  nodeType: string;
  title: string;
  outcome: 'completed' | 'terminal' | 'jump' | 'skipped' | 'escalated' | 'suspended';
  variables?: Record<string, unknown>;
}

export interface EngineExecutionResult {
  success: boolean;
  outcome: 'completed' | 'escalated' | 'error' | 'suspended';
  reason: string;
  trace: EngineStepTrace[];
  variables: Record<string, unknown>;
  terminalResult?: Record<string, unknown>;
  /** When outcome === 'suspended', the node to resume at on the next execute() call. */
  resumeNodeId?: string;
}

// ---------------------------------------------------------------------------
// Default Node Executors
// ---------------------------------------------------------------------------

async function executeStartNode(state: EngineState, node: ExecutableNode): Promise<NodeExecutionResult> {
  // Read global policy from start node config
  const maxLoops = Number(node.config.maxRegressionLoops);
  if (Number.isFinite(maxLoops) && maxLoops > 0) {
    state.maxRegressionLoops = maxLoops;
  }
  return { output: { phase: 'start' }, variables: {} };
}

async function executeIntakeNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const result = await services.intakeAndScore(ctx);
    return {
      output: { phase: 'intake', ...result },
      variables: {
        complexity: result.complexity,
        complexityScore: result.complexityScore,
        activePhases: result.activePhases,
        workUnitCount: result.workUnitCount,
        intakeComplete: true,
      },
    };
  }
  // Stub mode
  return {
    output: { phase: 'intake' },
    variables: {
      complexity: state.variables.complexity ?? 'medium',
      intakeComplete: true,
    },
  };
}

async function executePlannerNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const result = await services.runPlanning(ctx, {
      planningMode: String(node.config.planningMode ?? 'pm-planning'),
      stopAfterPlanning: node.config.stopAfterPlanning === true || node.config.stopAfterPlanning === 'true',
      architecturePreRound: node.config.architecturePreRound === true || node.config.architecturePreRound === 'true',
    });
    return {
      output: { phase: 'planning', ...result },
      variables: {
        stopAfterPlanning: result.stopAfterPlanning,
        planningComplete: true,
        planningDecomposition: result.planningDecomposition,
        agentAssignments: result.agentAssignments,
      },
    };
  }
  // Stub mode
  const stopAfterPlanning = node.config.stopAfterPlanning === true || node.config.stopAfterPlanning === 'true';
  return {
    output: { phase: 'planning' },
    variables: { stopAfterPlanning, planningComplete: true },
  };
}

async function executeLogicGateNode(state: EngineState, node: ExecutableNode): Promise<NodeExecutionResult> {
  const operator = String(node.config.operator ?? 'expression');
  const operands = Array.isArray(node.config.operands) ? node.config.operands.map(String) : [];
  const expression = node.config.expression ? String(node.config.expression) : undefined;
  const trueLabel = String(node.config.trueLabel ?? 'true');
  const falseLabel = String(node.config.falseLabel ?? 'false');

  const result = evaluateLogicGate(operator, operands, expression, state.variables);
  const selectedBranch = result ? trueLabel : falseLabel;

  logger.info(
    { nodeId: node.id, expression, result, selectedBranch, variables: state.variables },
    'Logic gate evaluated',
  );

  return {
    output: { gate: true, result, selectedBranch },
    variables: { _selectedBranch: selectedBranch },
  };
}

async function executeRouteAgentNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  const phase = String(node.config.phase ?? 'specialist_input');
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const result = await services.runSpecialistInput(ctx);
    return {
      output: { phase, ...result },
      variables: { [`${phase}Complete`]: true, specialistAgentId: result.agentId },
    };
  }
  return {
    output: { phase, routing: 'specialist-routed' },
    variables: { [`${phase}Complete`]: true },
  };
}

async function executeExecuteAgentNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const feedback = state.regressionFeedback;
  if (feedback) {
    logger.info({ nodeId: node.id, feedbackLength: feedback.length }, 'Injecting regression feedback into execution');
    state.regressionFeedback = undefined;
  }

  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const result = await services.runExecution(ctx, {
      agentBinding: String(node.config.agentBinding ?? 'routed-agent'),
      workType: String(node.config.workType ?? 'implementation'),
      primaryRole: node.config.primaryRole as string | undefined,
      reviewerRole: node.config.reviewerRole as string | undefined,
      agentId: node.config.agentId as string | undefined,
    }, feedback);
    state.nodeOutputs.set('_executionOutcome', result.outcome);
    const executionOutcome = result.outcome;
    if (executionOutcome && typeof executionOutcome === 'object' && (executionOutcome as Record<string, unknown>).dispatched === false) {
      return {
        output: { phase: 'execution', ...result, escalated: true },
        terminate: true,
        terminalResult: {
          outcome: 'escalated',
          reason: String((executionOutcome as Record<string, unknown>).reason || 'execute-agent dispatch failed'),
          agentId: result.agentId,
        },
      };
    }
    return {
      output: { phase: 'execution', ...result },
      variables: { executionComplete: true, selectedAgentId: result.agentId, selectedStrategy: result.strategy },
    };
  }
  return {
    output: { phase: 'execution', regressionFeedback: feedback ?? null },
    variables: { executionComplete: true },
  };
}

async function executeVerifyOutputNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const executionOutcome = state.nodeOutputs.get('_executionOutcome');
    const result = await services.runTesting(ctx, executionOutcome);
    if (result.escalated) {
      return { output: { phase: 'testing', escalated: true }, terminate: true, terminalResult: { outcome: 'escalated', reason: 'testing-escalation' } };
    }
    if (!result.passed) {
      state.regressionFeedback = result.feedback ?? 'Test verification failed';
    }
    return {
      output: { phase: 'testing', testPassed: result.passed },
      variables: { testPassed: result.passed },
    };
  }
  // Stub mode
  const testPassed = state.variables._testResult !== false;
  if (!testPassed) {
    state.regressionFeedback = String(state.variables._testFeedback ?? 'Test verification failed');
  }
  return {
    output: { phase: 'testing', testPassed },
    variables: { testPassed },
  };
}

async function executeReviewNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const executionOutcome = state.nodeOutputs.get('_executionOutcome');
    const result = await services.runReview(ctx, executionOutcome);
    if (result.escalated) {
      return { output: { phase: 'review', escalated: true }, terminate: true, terminalResult: { outcome: 'escalated', reason: 'review-escalation' } };
    }
    if (!result.passed) {
      state.regressionFeedback = result.feedback ?? 'Review rejected';
    }
    return {
      output: { phase: 'review', reviewPassed: result.passed },
      variables: { reviewPassed: result.passed },
    };
  }
  // Stub mode
  const reviewPassed = state.variables._reviewResult !== false;
  if (!reviewPassed) {
    state.regressionFeedback = String(state.variables._reviewFeedback ?? 'Review rejected');
  }
  return {
    output: { phase: 'review', reviewPassed },
    variables: { reviewPassed },
  };
}

async function executeDeliverNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    const executionOutcome = state.nodeOutputs.get('_executionOutcome');
    const result = await services.runDelivery(ctx, executionOutcome);
    return {
      output: { phase: 'delivery', ...result },
      terminate: true,
      terminalResult: { outcome: 'completed', delivered: result.delivered, variables: state.variables },
    };
  }
  return {
    output: { phase: 'delivery', deliveryMode: node.config.deliveryMode },
    terminate: true,
    terminalResult: { outcome: 'completed', variables: state.variables },
  };
}

async function executeEscalateNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const services = engine.getServices();
  if (services) {
    const ctx = engine.buildTicketContext(state);
    await services.escalate(ctx, String(node.config.target), String(node.config.severity), 'Graph engine escalation');
  }
  return {
    output: { phase: 'escalation', target: node.config.target, severity: node.config.severity },
    terminate: true,
    terminalResult: { outcome: 'escalated', target: node.config.target },
  };
}

async function executeApprovalGateNode(state: EngineState, node: ExecutableNode): Promise<NodeExecutionResult> {
  // Human approval gate: SUSPEND the run here. The caller (dispatch-graph-worker) persists the
  // resume point and parks the ticket at approval_required; operator approval re-runs execute()
  // with resumeFromNodeId set to this gate's successor, so the gate is not re-evaluated.
  return { output: { phase: 'approval-gate', awaitingApproval: true }, suspend: true };
}

async function executePassthroughNode(state: EngineState, node: ExecutableNode): Promise<NodeExecutionResult> {
  return { output: { passthrough: true } };
}

async function executeAiDecisionNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  // Ask the bound bot to pick the next branch. The chosen label is written to _selectedBranch,
  // which resolveNextNode matches against the outgoing edge labels. Falls back to a configured
  // default when no bot/decision service is wired or the bot's answer can't be matched.
  const outcomes = Array.isArray(node.config.outcomes)
    ? node.config.outcomes.map((o) => String(o).trim()).filter(Boolean)
    : [];
  const fallback = String(node.config.fallbackOutcome ?? outcomes[0] ?? 'default');

  const services = engine.getServices();
  if (services?.decideBranch && outcomes.length > 0) {
    try {
      const ctx = engine.buildTicketContext(state);
      const decision = await services.decideBranch(ctx, {
        agentBinding: (node.config.agentBinding ?? node.config.decisionAgent) as string | undefined,
        agentId: node.config.agentId as string | undefined,
        outcomes,
        prompt: (node.config.prompt as string | undefined) ?? node.title,
      });
      const answer = String(decision?.outcome ?? '').toLowerCase();
      const chosen = outcomes.find((o) => o.toLowerCase() === answer)
        ?? outcomes.find((o) => answer.includes(o.toLowerCase()))
        ?? fallback;
      logger.info({ nodeId: node.id, answer: decision?.outcome, chosen }, 'AI decision resolved by bot');
      return { output: { decision: chosen, source: 'bot' }, variables: { _selectedBranch: chosen } };
    } catch (error) {
      logger.warn({ nodeId: node.id, err: (error as Error).message }, 'ai-decision dispatch failed — using fallback');
    }
  }

  return { output: { decision: fallback, source: 'fallback' }, variables: { _selectedBranch: fallback } };
}

/**
 * Agent-cluster step: dispatch a ranked cluster of agents on the same work concurrently, then let a
 * reviewer gate the candidates (pass + winner, or fail). A pass advances with the winner recorded as
 * the execution outcome; a fail sets regression feedback + clusterPassed=false so the author can wire
 * a logic-gate/loop-back (mirrors verify-output/review). Stub mode (no services) passes through.
 */
async function executeAgentClusterNode(state: EngineState, node: ExecutableNode, engine: ProcessDefinitionExecutionEngine): Promise<NodeExecutionResult> {
  const agents = Array.isArray(node.config.agents)
    ? node.config.agents.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const reviewer = node.config.reviewer ? String(node.config.reviewer) : undefined;
  const feedback = state.regressionFeedback;
  if (feedback) state.regressionFeedback = undefined;

  const services = engine.getServices();
  if (services?.runClusterStep && agents.length > 0) {
    const ctx = engine.buildTicketContext(state);
    const result = await services.runClusterStep(ctx, {
      agents,
      reviewer,
      workType: String(node.config.workType ?? 'cluster'),
      feedback,
    });
    if (!result.passed) {
      state.regressionFeedback = result.feedback ?? 'Agent cluster review did not pass';
      return {
        output: { phase: 'cluster', ...result },
        variables: { clusterPassed: false, clusterComplete: true },
      };
    }
    state.nodeOutputs.set('_executionOutcome', { dispatched: true, agentId: result.winnerAgentId });
    return {
      output: { phase: 'cluster', ...result },
      variables: { clusterPassed: true, clusterWinner: result.winnerAgentId, executionComplete: true, clusterComplete: true },
    };
  }

  // Stub mode (tests / no services wired): pass through so the graph still advances.
  return {
    output: { phase: 'cluster', stub: true, memberCount: agents.length },
    variables: { clusterPassed: true, executionComplete: true, clusterComplete: true },
  };
}

async function executeSubProcessNode(state: EngineState, node: ExecutableNode): Promise<NodeExecutionResult> {
  // Future: invoke another ProcessDefinition
  return { output: { subProcess: 'not-implemented' } };
}
