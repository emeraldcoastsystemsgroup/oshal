/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Engine state interface — carries all accumulated data as the engine walks the graph
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | EngineStateSnapshot + snapshotEngineState/applyEngineSnapshot for durable checkpoint/resume (Maps <-> JSON).
 */

/**
 * Mutable state carried through the engine as it walks a ProcessDefinition graph.
 * Each node executor reads from and writes to this state.
 */
export interface EngineState {
  // --- Identity ---
  runId: string;
  workspaceTaskId: string;
  runStartedAt: number;

  // --- Ticket context (set when running a real ticket) ---
  ticket?: Record<string, unknown>;

  // --- Accumulated outputs (keyed by nodeId) ---
  nodeOutputs: Map<string, unknown>;

  // --- Regression tracking ---
  regressionFeedback?: string;
  regressionLoopCount: number;
  maxRegressionLoops: number;

  // --- Branch evaluation context ---
  // Variables set by node executors, read by logic-gate/ai-decision evaluators.
  // Examples: complexity, stopAfterPlanning, testPassed, reviewPassed
  variables: Record<string, unknown>;

  // --- Visited node tracking (for regression loop detection) ---
  visitCounts: Map<string, number>;
}

/**
 * Creates a fresh EngineState for a new processing run.
 */
export function createEngineState(runId: string, workspaceTaskId: string, ticket?: Record<string, unknown>): EngineState {
  return {
    runId,
    workspaceTaskId,
    runStartedAt: Date.now(),
    ticket,
    nodeOutputs: new Map(),
    regressionLoopCount: 0,
    maxRegressionLoops: 3,
    variables: {},
    visitCounts: new Map(),
  };
}

/**
 * A serializable snapshot of the accumulated engine progress — everything a resumed run needs to
 * continue where a prior run stopped (crash, restart, or approval-gate suspend) WITHOUT re-executing
 * the nodes that already completed. Identity/timing fields are per-run and deliberately omitted.
 */
export interface EngineStateSnapshot {
  variables: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  visitCounts: Record<string, number>;
  regressionLoopCount: number;
  regressionFeedback?: string;
}

/**
 * @description Capture the accumulated state (variables, node outputs, visit counts, regression
 * progress) as a plain JSON-serializable snapshot for durable checkpointing. Maps become objects.
 * @param state - the live engine state
 * @returns a serializable snapshot
 */
export function snapshotEngineState(state: EngineState): EngineStateSnapshot {
  return {
    variables: { ...state.variables },
    nodeOutputs: Object.fromEntries(state.nodeOutputs),
    visitCounts: Object.fromEntries(state.visitCounts),
    regressionLoopCount: state.regressionLoopCount,
    ...(state.regressionFeedback ? { regressionFeedback: state.regressionFeedback } : {}),
  };
}

/**
 * @description Seed a fresh engine state from a saved snapshot so a resumed run continues with the
 * variables/outputs/visit-counts the prior run had accumulated. Restores objects back into Maps.
 * @param state - the fresh engine state to seed (mutated in place)
 * @param snapshot - a snapshot from snapshotEngineState
 * @returns the same state, seeded
 */
export function applyEngineSnapshot(state: EngineState, snapshot: EngineStateSnapshot): EngineState {
  Object.assign(state.variables, snapshot.variables ?? {});
  for (const [k, v] of Object.entries(snapshot.nodeOutputs ?? {})) state.nodeOutputs.set(k, v);
  for (const [k, v] of Object.entries(snapshot.visitCounts ?? {})) state.visitCounts.set(k, Number(v) || 0);
  if (typeof snapshot.regressionLoopCount === 'number') state.regressionLoopCount = snapshot.regressionLoopCount;
  if (snapshot.regressionFeedback) state.regressionFeedback = snapshot.regressionFeedback;
  return state;
}
