/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * (new)               | workflow-publish            | Compiles an authored workflow spec into a SwarmAppManifest. This is the bridge that turns a Workflow-Studio canvas / builder-bot spec into a runnable app == queue. Two emit targets: a single-shot bot (manifest-worker pipeline, "Branch A") or an authored multi-bot workflow (staged pipeline, "Branch B"). Owner/scope are applied by the publish route from the session — NOT taken from this spec.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | mode:'graph' (Branch C) compiles a full canvas graph (branches/parallel/decisions) to an executable nodeGraph; per-workflow autoStart passthrough; agent-cluster node accepted (config.agents>=1, counts as an agent node).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: both emit paths stamp suite: ai-productivity — published workflows are user-authored automations and must not land unshelved (loader warns on a missing suite).
 */

import type { SwarmAppManifest, SwarmAppScope, SwarmAppWorkflow } from '../types';

/** One authored stage (Branch B): an existing bot pinned to a step, optional gate. */
export interface WorkflowPublishStageInput {
  bot: string;
  name?: string;
  approvalAfter?: boolean;
}

/** Optional bot declaration so a brand-new bot gets seeded into the agents table. */
export interface WorkflowPublishBotInput {
  agentId: string;
  name: string;
  persona?: string;
  role?: string;
  capabilities?: string[];
}

/** One node of an authored canvas graph (Branch C): the full graph, not a linear stage list. */
export interface WorkflowPublishGraphNode {
  id: string;
  type: string;
  title?: string;
  config?: Record<string, unknown>;
}

/** One edge of an authored canvas graph. `label` drives branch selection at decision nodes. */
export interface WorkflowPublishGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

/** A full authored canvas graph (Branch C) — branches, parallel splits, gates and all. */
export interface WorkflowPublishGraphInput {
  nodes: WorkflowPublishGraphNode[];
  edges: WorkflowPublishGraphEdge[];
}

/**
 * @description The authored workflow spec the publish endpoint accepts. Emitted by
 * the Workflow Studio canvas or the builder bot. Deliberately small and runtime-shaped
 * — it maps 1:1 onto the manifest the loader/dispatcher already understand.
 */
export interface WorkflowPublishSpec {
  /** Slug — becomes the app name, queueId, and (default) ticketType. */
  name: string;
  displayName?: string;
  description?: string;
  /**
   * 'single-shot' → one worker bot (Branch A). 'staged' → ordered bots + gates (Branch B).
   * 'graph' → a full authored canvas graph with branches/parallel/decisions (Branch C).
   */
  mode: 'single-shot' | 'staged' | 'graph';
  /** Ticket type the queue handles. Defaults to `name`. */
  ticketType?: string;
  /** Required when mode='single-shot' — the one bot that owns the whole ticket. */
  workerBot?: string;
  /** Required when mode='staged' — the ordered, bot-pinned stages. */
  stages?: WorkflowPublishStageInput[];
  /** Required when mode='graph' — the full canvas graph (branches, parallel, gates). */
  graph?: WorkflowPublishGraphInput;
  /** When true, tickets of this workflow auto-approve on arrival and run without a manual backlog
   *  gate (human pauses live in the graph's approval-gate nodes). Default false = manual approval. */
  autoStart?: boolean;
  /** Optional explicit bot declarations (so new bots seed); existing bots need not be listed. */
  bots?: WorkflowPublishBotInput[];
}

/** Canvas node types that dispatch to a bot (must carry a resolvable agentBinding). */
const BOT_GRAPH_NODE_TYPES = new Set(['execute-agent', 'route-agent', 'ai-decision']);
/** Canvas node types the execution engine knows how to run. */
const KNOWN_GRAPH_NODE_TYPES = new Set([
  'start', 'intake-source', 'planner', 'route-agent', 'ai-decision', 'logic-gate',
  'execute-agent', 'verify-output', 'review', 'deliver', 'escalate', 'approval-gate',
  'parallel-split', 'parallel-join', 'sub-process', 'agent-cluster',
]);

/** Slug rules for an app/queue name: lowercase, digits, dashes; 2–64 chars. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * @description Validate + compile an authored spec into a SwarmAppManifest. Throws
 * Error (with a human message) on invalid input — the route maps that to a 400.
 * The `scope` is supplied by the route (from the session/operator decision); owner
 * is applied later at load time, never embedded here.
 *
 * @param spec - the authored workflow spec
 * @param scope - visibility scope decided by the publish route
 * @returns a manifest ready to serialize + load
 */
export function compileWorkflowSpec(spec: WorkflowPublishSpec, scope: SwarmAppScope): SwarmAppManifest {
  if (!spec || typeof spec !== 'object') throw new Error('spec is required');
  const name = String(spec.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new Error('name must be a slug: lowercase letters, digits, dashes; 2–64 chars (e.g. "sales-pipeline")');
  }
  const displayName = String(spec.displayName ?? '').trim() || name;
  const ticketType = String(spec.ticketType ?? '').trim() || name;

  // Branch C — a full authored canvas graph. Compile it straight to the engine's nodeGraph
  // (branches, parallel splits, gates, decisions) rather than flattening to a linear stage list.
  if (spec.mode === 'graph') {
    return compileGraphSpec(spec, scope, name, displayName, ticketType);
  }

  // Normalize both modes to an ordered stage list, then compile to a graph the engine runs.
  // Unifying on the 'graph' pipeline means ONE runtime engine for published workflows
  // (single-shot is just a one-stage graph). 'staged'/'manifest-worker' remain available for
  // hand-authored manifests but publish no longer emits them.
  let stages: Array<{ bot: string; name?: string; approvalAfter?: boolean }>;
  if (spec.mode === 'staged') {
    const raw = Array.isArray(spec.stages) ? spec.stages : [];
    if (raw.length === 0) throw new Error('staged workflow requires at least one stage');
    stages = raw.map((s, i) => {
      const bot = String(s?.bot ?? '').trim();
      if (!bot) throw new Error(`stage ${i + 1} is missing a bot`);
      return {
        bot,
        name: s.name ? String(s.name).trim() : undefined,
        approvalAfter: s.approvalAfter === true ? true : undefined,
      };
    });
  } else if (spec.mode === 'single-shot') {
    const workerBot = String(spec.workerBot ?? '').trim();
    if (!workerBot) throw new Error('single-shot workflow requires workerBot');
    stages = [{ bot: workerBot }];
  } else {
    throw new Error("mode must be 'single-shot', 'staged', or 'graph'");
  }

  const workflow: SwarmAppWorkflow = {
    name: displayName,
    pipeline: 'graph',
    workerBot: stages[0].bot, // informational; the graph drives execution
    stages,
    processDefinition: buildNodeGraphProcessDefinition(displayName, stages),
    ...(spec.autoStart === true ? { autoStart: true } : {}),
  };

  const bots = Array.isArray(spec.bots)
    ? spec.bots
        .filter((b) => b && typeof b.agentId === 'string' && b.agentId.length > 0)
        .map((b) => ({
          agentId: b.agentId,
          name: b.name,
          persona: b.persona,
          role: b.role,
          capabilities: b.capabilities,
        }))
    : undefined;

  return {
    name,
    displayName,
    description: spec.description ? String(spec.description) : undefined,
    scope,
    // ADR-097: published workflows are user-authored automations — they shelve under the
    // general-purpose suite rather than warning at load as unshelved.
    suite: 'ai-productivity',
    ...(bots && bots.length ? { bots } : {}),
    ticketType,
    workflow,
  };
}

/**
 * Build a minimal ProcessDefinition (nodeGraph) the ProcessDefinitionExecutionEngine runs:
 *   start -> execute-agent(stage 1) [-> approval-gate] -> execute-agent(stage 2) -> ... -> deliver
 * Each stage's bot rides as config.agentBinding (the engine's EngineServices adapter resolves
 * the name to an agentId at dispatch). This is the linear stage-list -> graph path; richer
 * branching graphs come from the canvas compiler, not from a stage list. The object is kept
 * loosely typed (Record) to avoid a swarm-apps -> workflow-studio type dependency; the engine
 * only reads `.nodeGraph`.
 */
function buildNodeGraphProcessDefinition(
  name: string,
  stages: Array<{ bot: string; name?: string; approvalAfter?: boolean }>,
): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const addNode = (id: string, type: string, title: string, config: Record<string, unknown> = {}): void => {
    nodes.push({ id, type, title, config });
    order.push(id);
  };
  const link = (source: string, target: string): void => {
    edges.push({ id: `e-${source}-${target}`, source, target });
  };

  addNode('n-start', 'start', 'Start', { triggerMode: 'manual' });
  let prev = 'n-start';
  stages.forEach((stage, i) => {
    const stageLabel = stage.name || `Stage ${i + 1}`;
    const nodeId = `n-stage-${i}`;
    addNode(nodeId, 'execute-agent', stageLabel, { agentBinding: stage.bot, workType: 'authored' });
    link(prev, nodeId);
    prev = nodeId;
    if (stage.approvalAfter) {
      const gateId = `n-gate-${i}`;
      addNode(gateId, 'approval-gate', `Approve after ${stageLabel}`, { gateState: 'approval_required' });
      link(prev, gateId);
      prev = gateId;
    }
  });
  addNode('n-deliver', 'deliver', 'Deliver', { deliveryMode: 'standard' });
  link(prev, 'n-deliver');

  return { name, nodeGraph: { nodes, edges, topologicalOrder: order } };
}

/**
 * @description Compile a full authored canvas graph (Branch C) into a SwarmAppManifest whose
 * workflow runs on the ProcessDefinitionExecutionEngine. Validates the graph structurally, maps
 * each canvas node 1:1 onto an engine node (canvas node types == engine executor types), and
 * preserves branch/parallel/gate edges (with labels) so decisions and fan-out actually execute.
 *
 * @param spec - the authored graph spec (spec.graph holds nodes + edges)
 * @param scope - visibility scope decided by the publish route
 * @param name - validated slug
 * @param displayName - human label
 * @param ticketType - ticket type the queue handles
 * @returns a manifest ready to serialize + load
 */
function compileGraphSpec(
  spec: WorkflowPublishSpec,
  scope: SwarmAppScope,
  name: string,
  displayName: string,
  ticketType: string,
): SwarmAppManifest {
  const graph = spec.graph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("graph workflow requires graph.nodes and graph.edges");
  }
  const nodes = graph.nodes;
  const edges = graph.edges;
  if (nodes.length === 0) throw new Error('graph workflow has no nodes');

  const ids = new Set<string>();
  for (const node of nodes) {
    const id = String(node?.id ?? '').trim();
    if (!id) throw new Error('every graph node needs an id');
    if (ids.has(id)) throw new Error(`duplicate node id: ${id}`);
    ids.add(id);
    const type = String(node?.type ?? '').trim();
    if (!KNOWN_GRAPH_NODE_TYPES.has(type)) {
      throw new Error(`node "${node.title || id}" has unsupported type "${type}"`);
    }
    if (BOT_GRAPH_NODE_TYPES.has(type)) {
      const binding = String(node.config?.agentBinding ?? node.config?.agentId ?? '').trim();
      if (!binding) {
        throw new Error(`node "${node.title || id}" needs a bot selected (agentBinding)`);
      }
    }
    if (type === 'agent-cluster') {
      const members = Array.isArray(node.config?.agents) ? node.config.agents.filter((a) => String(a).trim()) : [];
      if (members.length === 0) {
        throw new Error(`node "${node.title || id}" is an agent-cluster and needs at least one member in config.agents`);
      }
    }
  }

  const startNodes = nodes.filter((n) => n.type === 'start');
  if (startNodes.length !== 1) {
    throw new Error(`graph needs exactly one start node (found ${startNodes.length})`);
  }
  // An "agent node" is a single-bot node OR an agent-cluster (multiple members). Either satisfies
  // the "graph must do real agent work" requirement.
  const agentNodes = nodes.filter((n) => BOT_GRAPH_NODE_TYPES.has(n.type) || n.type === 'agent-cluster');
  if (agentNodes.length === 0) {
    throw new Error('graph needs at least one agent node with a bot selected');
  }

  // Edges must reference real nodes; approval gates inside a parallel region aren't supported (v1).
  for (const edge of edges) {
    if (!ids.has(String(edge.source))) throw new Error(`edge ${edge.id} has an unknown source ${edge.source}`);
    if (!ids.has(String(edge.target))) throw new Error(`edge ${edge.id} has an unknown target ${edge.target}`);
  }
  assertNoGatesInParallelRegions(nodes, edges);

  const engineNodes = nodes.map((node) => ({
    id: String(node.id),
    type: String(node.type),
    title: node.title ? String(node.title) : String(node.type),
    config: { ...(node.config ?? {}) },
  }));
  const engineEdges = edges.map((edge) => ({
    id: String(edge.id),
    source: String(edge.source),
    target: String(edge.target),
    ...(edge.label ? { label: String(edge.label) } : {}),
  }));
  const topologicalOrder = topoOrderGraph(engineNodes.map((n) => n.id), engineEdges, startNodes[0].id);

  const stages = agentNodes.map((n) => ({
    bot: n.type === 'agent-cluster'
      ? String((Array.isArray(n.config?.agents) ? n.config.agents[0] : '') || 'cluster')
      : String(n.config?.agentBinding ?? n.config?.agentId),
    name: n.title ? String(n.title) : undefined,
  }));

  const workflow: SwarmAppWorkflow = {
    name: displayName,
    pipeline: 'graph',
    workerBot: stages[0].bot, // informational; the graph drives execution
    stages,
    processDefinition: { name: displayName, nodeGraph: { nodes: engineNodes, edges: engineEdges, topologicalOrder } },
    ...(spec.autoStart === true ? { autoStart: true } : {}),
  };

  const bots = Array.isArray(spec.bots)
    ? spec.bots
        .filter((b) => b && typeof b.agentId === 'string' && b.agentId.length > 0)
        .map((b) => ({ agentId: b.agentId, name: b.name, persona: b.persona, role: b.role, capabilities: b.capabilities }))
    : undefined;

  return {
    name,
    displayName,
    description: spec.description ? String(spec.description) : undefined,
    scope,
    suite: 'ai-productivity', // ADR-097 — same shelving rule as the linear publish path above
    ...(bots && bots.length ? { bots } : {}),
    ticketType,
    workflow,
  };
}

/**
 * Reject approval-gate / terminal nodes that sit between a parallel-split and its parallel-join.
 * The engine runs parallel branches without cross-branch suspend, so a gate there can't pause
 * cleanly — caught at publish with a clear message instead of misbehaving at runtime.
 */
function assertNoGatesInParallelRegions(
  nodes: WorkflowPublishGraphNode[],
  edges: WorkflowPublishGraphEdge[],
): void {
  const typeById = new Map(nodes.map((n) => [String(n.id), String(n.type)]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(String(e.source)) ?? [];
    list.push(String(e.target));
    outgoing.set(String(e.source), list);
  }
  for (const split of nodes.filter((n) => n.type === 'parallel-split')) {
    const seen = new Set<string>();
    const queue = [...(outgoing.get(String(split.id)) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const type = typeById.get(id);
      if (type === 'parallel-join') continue; // reached the join — stop descending this path
      if (type === 'approval-gate') {
        throw new Error('approval gates are not supported inside a parallel branch — move the gate before the split or after the join');
      }
      for (const next of outgoing.get(id) ?? []) queue.push(next);
    }
  }
}

/**
 * Best-effort topological order (Kahn) for the nodeGraph metadata. The engine walks edges from the
 * start node and does not depend on this order, so cycles just fall back to declared node order.
 */
function topoOrderGraph(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
  startId: string,
): string[] {
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    const list = outgoing.get(e.source) ?? [];
    list.push(e.target);
    outgoing.set(e.source, list);
  }
  const queue = [startId, ...nodeIds.filter((id) => id !== startId && (indegree.get(id) ?? 0) === 0)];
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg <= 0) queue.push(next);
    }
  }
  for (const id of nodeIds) if (!seen.has(id)) order.push(id); // cycle remainder, declared order
  return order;
}
