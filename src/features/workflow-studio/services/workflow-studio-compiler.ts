/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow-studio validation and compile-preview helpers for design-time swarm integration
 */

import type {
  WorkflowCompilePreview,
  WorkflowCompileStepBinding,
  WorkflowDefinition,
  WorkflowNodeType,
  WorkflowValidationIssue,
  WorkflowValidationReport,
} from '../schemas/workflow-studio-schemas';
import {
  NON_INTERFERENCE_RULES,
  getWorkflowNodeCatalogEntry,
} from '../schemas/workflow-studio-schemas';

const MULTI_BRANCH_NODE_TYPES = new Set<WorkflowNodeType>([
  'start',
  'verify-output',
  'parallel-join',
  'parallel-split',
  'route-agent',
  'ai-decision',
  'logic-gate',
]);
const TERMINAL_NODE_TYPES = new Set<WorkflowNodeType>(['deliver', 'escalate']);
const BRANCH_NODE_TYPES = new Set<WorkflowNodeType>(['ai-decision', 'logic-gate', 'parallel-split']);

/**
 * @description Snapshot of a single swarm agent used by the compiler to resolve design-time
 * agent references (decision/route/execute targets and capability requirements) against the
 * persisted roster without coupling to live runtime agent objects.
 */
export interface WorkflowCompilerAgentSummary {
  agentId: string;
  name: string;
  status: string;
  baseCapabilities: string[];
  routingKeywords: string[];
}

/**
 * @description Ambient input for validation and compile-preview that carries the available agent
 * roster and whether it could be loaded, so agent-compatibility checks can be performed or safely
 * skipped (with an informational notice) when the roster is unavailable.
 */
export interface WorkflowCompilerContext {
  agents: WorkflowCompilerAgentSummary[];
  rosterStatus: 'available' | 'unavailable';
}

const DEFAULT_COMPILER_CONTEXT: WorkflowCompilerContext = {
  agents: [],
  rosterStatus: 'unavailable',
};

/**
 * @description Runs design-time structural and semantic checks on a workflow graph (duplicate ids,
 * start/deliver presence, edge connectivity, branch/join shape, cycles, unreachable nodes, and
 * roster-aware agent/capability resolution) and returns a report of issues without affecting any
 * runtime swarm behavior.
 * @param definition The workflow graph (nodes and edges) to validate.
 * @param context Available agent roster and load status used for agent-compatibility checks; defaults to an empty, unavailable roster.
 * @returns A validation report listing all issues plus aggregate counts and an overall valid flag (false when any error-level issue exists).
 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
  context: WorkflowCompilerContext = DEFAULT_COMPILER_CONTEXT,
): WorkflowValidationReport {
  const issues: WorkflowValidationIssue[] = [];
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const duplicateNodeIds = findDuplicateIds(definition.nodes.map((node) => node.id));
  const duplicateEdgeIds = findDuplicateIds(definition.edges.map((edge) => edge.id));
  const startNodes = definition.nodes.filter((node) => node.type === 'start');
  let requiresAgentRosterNotice = false;

  for (const duplicateNodeId of duplicateNodeIds) {
    issues.push({
      level: 'error',
      code: 'duplicate-node-id',
      message: `Node id is duplicated: ${duplicateNodeId}`,
      entityId: duplicateNodeId,
    });
  }

  for (const duplicateEdgeId of duplicateEdgeIds) {
    issues.push({
      level: 'error',
      code: 'duplicate-edge-id',
      message: `Edge id is duplicated: ${duplicateEdgeId}`,
      entityId: duplicateEdgeId,
    });
  }

  if (startNodes.length === 0) {
    issues.push({
      level: 'error',
      code: 'missing-start-node',
      message: 'A workflow definition requires one start node.',
    });
  }

  if (startNodes.length > 1) {
    issues.push({
      level: 'error',
      code: 'multiple-start-nodes',
      message: 'Only one start node is supported in the current design-time compiler.',
    });
  }

  for (const edge of definition.edges) {
    if (!nodeMap.has(edge.source)) {
      issues.push({
        level: 'error',
        code: 'missing-edge-source',
        message: `Edge ${edge.id} points to a missing source node.`,
        entityId: edge.id,
      });
      continue;
    }
    if (!nodeMap.has(edge.target)) {
      issues.push({
        level: 'error',
        code: 'missing-edge-target',
        message: `Edge ${edge.id} points to a missing target node.`,
        entityId: edge.id,
      });
      continue;
    }
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);

    if (edge.source === edge.target) {
      issues.push({
        level: 'warning',
        code: 'self-loop',
        message: `Edge ${edge.id} loops a node back onto itself. The current compiler only previews loops; it does not own runtime recursion.`,
        entityId: edge.id,
      });
    }
  }

  for (const node of definition.nodes) {
    const outgoing = outgoingCount.get(node.id) ?? 0;
    const incoming = incomingCount.get(node.id) ?? 0;

    if (node.type !== 'start' && incoming === 0) {
      issues.push({
        level: 'warning',
        code: 'unwired-node',
        message: `${node.title} is not reachable from any upstream edge.`,
        entityId: node.id,
      });
    }

    if (!TERMINAL_NODE_TYPES.has(node.type) && outgoing === 0) {
      issues.push({
        level: 'warning',
        code: 'no-outgoing-edge',
        message: `${node.title} has no outgoing edge. The workflow may stop earlier than intended.`,
        entityId: node.id,
      });
    }

    if (outgoing > 1 && !MULTI_BRANCH_NODE_TYPES.has(node.type)) {
      issues.push({
        level: 'warning',
        code: 'implicit-branch',
        message: `${node.title} fans out to multiple downstream nodes. Add an explicit branch or join note if that is intentional.`,
        entityId: node.id,
      });
    }

    if (BRANCH_NODE_TYPES.has(node.type) && outgoing < 2) {
      issues.push({
        level: 'warning',
        code: 'branch-node-needs-multiple-exits',
        message: `${node.title} is a branch node and should have at least two outgoing edges.`,
        entityId: node.id,
      });
    }

    if (node.type === 'parallel-join' && incoming < 2) {
      issues.push({
        level: 'warning',
        code: 'join-node-needs-multiple-inputs',
        message: `${node.title} should collect at least two incoming branches.`,
        entityId: node.id,
      });
    }

    if ((node.type === 'ai-decision' || node.type === 'logic-gate') && outgoing >= 2) {
      const unlabeledEdges = definition.edges.filter((edge) => edge.source === node.id && !edge.label);
      if (unlabeledEdges.length > 0) {
        issues.push({
          level: 'warning',
          code: 'decision-edges-should-be-labeled',
          message: `${node.title} has branch edges without labels. Name the paths so the decision gate is readable.`,
          entityId: node.id,
        });
      }
    }

    if (node.type === 'parallel-split') {
      const expectedBranches = Number(node.config.expectedBranches ?? 0);
      if (Number.isFinite(expectedBranches) && expectedBranches > 0 && outgoing > 0 && outgoing !== expectedBranches) {
        issues.push({
          level: 'warning',
          code: 'parallel-branch-count-mismatch',
          message: `${node.title} expects ${expectedBranches} branches but currently has ${outgoing}.`,
          entityId: node.id,
        });
      }

      if (Number.isFinite(expectedBranches) && expectedBranches > 0 && expectedBranches < 2) {
        issues.push({
          level: 'warning',
          code: 'parallel-split-too-small',
          message: `${node.title} should target at least two branches when it is used as a parallel split.`,
          entityId: node.id,
        });
      }

      const branchLabels = readStringArray(node.config.branchLabels);
      if (branchLabels.length > 0 && Number.isFinite(expectedBranches) && expectedBranches > 0 && branchLabels.length < expectedBranches) {
        issues.push({
          level: 'info',
          code: 'parallel-branch-labels-short',
          message: `${node.title} defines fewer branch labels than its expected branch count.`,
          entityId: node.id,
        });
      }
    }

    if (node.type === 'ai-decision') {
      const outcomes = readStringArray(node.config.outcomes);
      const fallbackOutcome = readOptionalString(node.config.fallbackOutcome);
      const decisionAgentId = readOptionalString(node.config.decisionAgentId);
      const requiredCapabilities = readStringArray(node.config.requiredCapabilities);

      if (outcomes.length < 2) {
        issues.push({
          level: 'warning',
          code: 'ai-decision-needs-outcomes',
          message: `${node.title} should define at least two outcomes so the branch intent is explicit.`,
          entityId: node.id,
        });
      }

      if (fallbackOutcome && outcomes.length > 0 && !outcomes.includes(fallbackOutcome)) {
        issues.push({
          level: 'warning',
          code: 'ai-decision-fallback-missing',
          message: `${node.title} uses a fallback outcome that is not listed in its defined outcomes.`,
          entityId: node.id,
        });
      }

      if (!decisionAgentId && requiredCapabilities.length === 0) {
        issues.push({
          level: 'warning',
          code: 'ai-decision-needs-resolution-target',
          message: `${node.title} should point to a decision agent or required capabilities so the gate can resolve against the current swarm roster.`,
          entityId: node.id,
        });
      }

      if (referencesAgentRoster(node) && context.rosterStatus !== 'available') {
        requiresAgentRosterNotice = true;
      }

      if (decisionAgentId && context.rosterStatus === 'available') {
        const agent = findAgentById(context.agents, decisionAgentId);
        if (!agent) {
          issues.push({
            level: 'warning',
            code: 'decision-agent-not-found',
            message: `${node.title} references a decision agent that is not present in the current roster.`,
            entityId: node.id,
          });
        } else if (!isActiveAgentStatus(agent.status)) {
          issues.push({
            level: 'info',
            code: 'decision-agent-not-active',
            message: `${node.title} points to ${agent.name}, which is currently ${agent.status}.`,
            entityId: node.id,
          });
        }
      }

      if (requiredCapabilities.length > 0 && context.rosterStatus === 'available') {
        const matches = findCompatibleAgents(context.agents, requiredCapabilities);
        if (matches.length === 0) {
          issues.push({
            level: 'warning',
            code: 'decision-capabilities-no-match',
            message: `${node.title} requires capabilities that no current agent advertises.`,
            entityId: node.id,
          });
        }
      }
    }

    if (node.type === 'logic-gate') {
      const operator = readOptionalString(node.config.operator) ?? 'all';
      const operands = readStringArray(node.config.operands);
      const expression = readOptionalString(node.config.expression);
      const trueLabel = readOptionalString(node.config.trueLabel);
      const falseLabel = readOptionalString(node.config.falseLabel);

      if (operator === 'expression' && !expression) {
        issues.push({
          level: 'warning',
          code: 'logic-expression-missing',
          message: `${node.title} is set to expression mode but does not define an expression.`,
          entityId: node.id,
        });
      }

      if (operator !== 'expression' && operands.length === 0) {
        issues.push({
          level: 'warning',
          code: 'logic-operands-missing',
          message: `${node.title} should define operands for its logical comparison.`,
          entityId: node.id,
        });
      }

      if (trueLabel && falseLabel && trueLabel === falseLabel) {
        issues.push({
          level: 'warning',
          code: 'logic-branch-labels-collide',
          message: `${node.title} uses the same label for both true and false branches.`,
          entityId: node.id,
        });
      }
    }

    if (node.type === 'route-agent') {
      const preferredAgentId = readOptionalString(node.config.preferredAgentId);
      const requiredCapabilities = readStringArray(node.config.requiredCapabilities);

      if (referencesAgentRoster(node) && context.rosterStatus !== 'available') {
        requiresAgentRosterNotice = true;
      }

      if (preferredAgentId && context.rosterStatus === 'available') {
        const agent = findAgentById(context.agents, preferredAgentId);
        if (!agent) {
          issues.push({
            level: 'warning',
            code: 'route-agent-not-found',
            message: `${node.title} references a preferred agent that is not present in the current roster.`,
            entityId: node.id,
          });
        } else if (!isActiveAgentStatus(agent.status)) {
          issues.push({
            level: 'info',
            code: 'route-agent-not-active',
            message: `${node.title} points to ${agent.name}, which is currently ${agent.status}.`,
            entityId: node.id,
          });
        }
      }

      if (requiredCapabilities.length > 0 && context.rosterStatus === 'available') {
        const matches = findCompatibleAgents(context.agents, requiredCapabilities);
        if (matches.length === 0) {
          issues.push({
            level: 'warning',
            code: 'route-capabilities-no-match',
            message: `${node.title} requires capabilities that no current agent advertises.`,
            entityId: node.id,
          });
        }
      }
    }

    if (node.type === 'execute-agent') {
      const agentBinding = readOptionalString(node.config.agentBinding) ?? 'routed-agent';
      const agentId = readOptionalString(node.config.agentId);
      const requiredCapabilities = readStringArray(node.config.requiredCapabilities);

      if (agentBinding === 'fixed-agent' && !agentId) {
        issues.push({
          level: 'warning',
          code: 'execute-fixed-agent-missing',
          message: `${node.title} is configured for a fixed agent but no agent is selected.`,
          entityId: node.id,
        });
      }

      if (referencesAgentRoster(node) && context.rosterStatus !== 'available') {
        requiresAgentRosterNotice = true;
      }

      if (agentId && context.rosterStatus === 'available') {
        const agent = findAgentById(context.agents, agentId);
        if (!agent) {
          issues.push({
            level: 'warning',
            code: 'execute-agent-not-found',
            message: `${node.title} references an execution agent that is not present in the current roster.`,
            entityId: node.id,
          });
        } else if (!isActiveAgentStatus(agent.status)) {
          issues.push({
            level: 'info',
            code: 'execute-agent-not-active',
            message: `${node.title} points to ${agent.name}, which is currently ${agent.status}.`,
            entityId: node.id,
          });
        }
      }

      if (requiredCapabilities.length > 0 && context.rosterStatus === 'available') {
        const matches = findCompatibleAgents(context.agents, requiredCapabilities);
        if (matches.length === 0) {
          issues.push({
            level: 'warning',
            code: 'execute-capabilities-no-match',
            message: `${node.title} requires capabilities that no current agent advertises.`,
            entityId: node.id,
          });
        }
      }
    }
  }

  const cycleNodeIds = detectCycleNodeIds(definition);
  if (cycleNodeIds.length > 0) {
    issues.push({
      level: 'warning',
      code: 'cycle-detected',
      message: 'The canvas contains at least one cycle. The current compiler will preview it, but runtime ownership still belongs to the existing swarm services.',
      entityId: cycleNodeIds[0],
    });
  }

  const unreachableNodeIds = findUnreachableNodeIds(definition, startNodes[0]?.id);
  for (const unreachableNodeId of unreachableNodeIds) {
    const node = nodeMap.get(unreachableNodeId);
    issues.push({
      level: 'warning',
      code: 'unreachable-node',
      message: `${node?.title ?? unreachableNodeId} is not reachable from the start node.`,
      entityId: unreachableNodeId,
    });
  }

  if (!definition.nodes.some((node) => node.type === 'deliver')) {
    issues.push({
      level: 'warning',
      code: 'missing-deliver-node',
      message: 'No deliver node is present. This design will not show an explicit writeback or outcome handoff step.',
    });
  }

  if (requiresAgentRosterNotice) {
    issues.push({
      level: 'info',
      code: 'agent-roster-unavailable',
      message: 'Agent compatibility checks were skipped because the current persisted roster could not be loaded. Existing runtime behavior is unchanged.',
    });
  }

  return {
    valid: !issues.some((issue) => issue.level === 'error'),
    definitionId: definition.id,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
    issues,
  };
}

/**
 * @description Produces a design-time-only compile preview of a workflow by validating it,
 * topologically ordering its nodes into per-step bindings (runtime binding, downstream paths,
 * config summary, and compiler notes), and surfacing non-interference rules and an overall status,
 * documenting how the canvas maps onto existing swarm services rather than owning execution.
 * @param definition The workflow graph to compile into a preview.
 * @param context Available agent roster and load status used during validation and binding annotation; defaults to an empty, unavailable roster.
 * @returns A compile preview containing the validation report, ordered step bindings, distinct runtime bindings, entrypoint, integration mode, and readiness status.
 */
export function compileWorkflowDefinition(
  definition: WorkflowDefinition,
  context: WorkflowCompilerContext = DEFAULT_COMPILER_CONTEXT,
): WorkflowCompilePreview {
  const validation = validateWorkflowDefinition(definition, context);
  const stepBindings = topologicallyOrderNodes(definition).map((nodeId) => {
    const node = definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return null;
    }
    return buildStepBinding(definition, node.id, context);
  }).filter((binding): binding is WorkflowCompileStepBinding => binding !== null);
  const runtimeBindings = Array.from(new Set(stepBindings.map((binding) => binding.runtimeBinding)));

  return {
    definitionId: definition.id,
    definitionName: definition.name,
    entrypointNodeId: definition.nodes.find((node) => node.type === 'start')?.id,
    integrationMode: 'design_time_only',
    nonInterferenceRules: NON_INTERFERENCE_RULES,
    runtimeBindings,
    status: validation.issues.some((issue) => issue.level !== 'info') ? 'attention' : 'ready',
    stepBindings,
    validation,
  };
}

function buildStepBinding(
  definition: WorkflowDefinition,
  nodeId: string,
  context: WorkflowCompilerContext,
): WorkflowCompileStepBinding {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Workflow node not found during compile preview: ${nodeId}`);
  }
  const catalogEntry = getWorkflowNodeCatalogEntry(node.type);
  const downstreamNodes = definition.edges
    .filter((edge) => edge.source === node.id)
    .map((edge) => {
      const targetTitle = definition.nodes.find((candidate) => candidate.id === edge.target)?.title ?? edge.target;
      return edge.label ? `${edge.label} -> ${targetTitle}` : targetTitle;
    });

  return {
    nodeId: node.id,
    title: node.title,
    nodeType: node.type,
    runtimeBinding: catalogEntry.runtimeBinding,
    downstreamNodes,
    configSummary: summarizeConfig(node.type, node.config),
    compilerNotes: [
      ...getCompilerNotes(node.type),
      ...getDynamicCompilerNotes(node, context),
    ],
  };
}

function summarizeConfig(type: WorkflowNodeType, config: Record<string, unknown>): string[] {
  const entry = getWorkflowNodeCatalogEntry(type);
  return entry.fields.map((field) => {
    const rawValue = config[field.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return `${field.label}: not set`;
    }
    if (Array.isArray(rawValue)) {
      return `${field.label}: ${rawValue.join(', ')}`;
    }
    return `${field.label}: ${String(rawValue)}`;
  });
}

function getCompilerNotes(type: WorkflowNodeType): string[] {
  switch (type) {
    case 'start':
      return ['Editor-only entry marker. It documents runtime attachment points but does not own execution.'];
    case 'intake-source':
      return ['Compiles to an intake contract preview. Existing provider routes stay authoritative.'];
    case 'planner':
      return ['Maps onto the current PlanningRoundOrchestrator and PM planning flow.'];
    case 'route-agent':
      return ['Delegates winner selection to the existing PhaseRoutingService and PM assignment rules.'];
    case 'ai-decision':
      return ['AI decision nodes are design-time branch annotations that can target real swarm agents or capability classes.'];
    case 'logic-gate':
      return ['Logical gates describe deterministic branch rules without replacing the existing runtime decision chain.'];
    case 'execute-agent':
      return ['Documents a worker dispatch step. Existing swarm workers and lifecycle services remain in control.'];
    case 'parallel-split':
      return ['Parallel split nodes describe fan-out intent while existing swarm execution remains authoritative.'];
    case 'approval-gate':
      return ['References the current build gate states instead of adding a new approval engine.'];
    case 'verify-output':
      return ['Binds to the existing verification service and retry-aware policy path.'];
    case 'review':
      return ['Uses the current review/consensus model already present in swarm orchestration.'];
    case 'deliver':
      return ['Maps to the current writeback/delivery path.'];
    case 'escalate':
      return ['Documents an escalation branch routed through the existing escalation store and policy.'];
    case 'parallel-join':
      return ['Acts as a design-time branch convergence marker. Runtime fan-in still belongs to the current swarm control flow.'];
    default:
      return ['No compiler note available.'];
  }
}

function getDynamicCompilerNotes(
  node: WorkflowDefinition['nodes'][number],
  context: WorkflowCompilerContext,
): string[] {
  const notes: string[] = [];
  const hasRoster = context.rosterStatus === 'available';

  if (node.type === 'ai-decision') {
    const outcomes = readStringArray(node.config.outcomes);
    if (outcomes.length > 0) {
      notes.push(`Decision outcomes: ${outcomes.join(', ')}`);
    }

    const decisionAgentId = readOptionalString(node.config.decisionAgentId);
    if (decisionAgentId) {
      const agent = findAgentById(context.agents, decisionAgentId);
      notes.push(agent
        ? `Decision agent: ${agent.name} (${agent.status})`
        : hasRoster
          ? 'Decision agent: not found in current roster'
          : 'Decision agent compatibility skipped because roster is unavailable');
    }

    const requiredCapabilities = readStringArray(node.config.requiredCapabilities);
    if (requiredCapabilities.length > 0) {
      notes.push(buildCapabilityMatchNote('Decision candidates', requiredCapabilities, context));
    }
  }

  if (node.type === 'logic-gate') {
    const operator = readOptionalString(node.config.operator);
    const operands = readStringArray(node.config.operands);
    if (operator) {
      notes.push(`Logic operator: ${operator}`);
    }
    if (operands.length > 0) {
      notes.push(`Logic operands: ${operands.join(', ')}`);
    }
  }

  if (node.type === 'parallel-split') {
    const branchLabels = readStringArray(node.config.branchLabels);
    if (branchLabels.length > 0) {
      notes.push(`Parallel branches: ${branchLabels.join(', ')}`);
    }
  }

  if (node.type === 'route-agent') {
    const preferredAgentId = readOptionalString(node.config.preferredAgentId);
    if (preferredAgentId) {
      const agent = findAgentById(context.agents, preferredAgentId);
      notes.push(agent
        ? `Preferred agent: ${agent.name} (${agent.status})`
        : hasRoster
          ? 'Preferred agent: not found in current roster'
          : 'Preferred agent compatibility skipped because roster is unavailable');
    }

    const requiredCapabilities = readStringArray(node.config.requiredCapabilities);
    if (requiredCapabilities.length > 0) {
      notes.push(buildCapabilityMatchNote('Routing candidates', requiredCapabilities, context));
    }
  }

  if (node.type === 'execute-agent') {
    const agentBinding = readOptionalString(node.config.agentBinding);
    const agentId = readOptionalString(node.config.agentId);
    if (agentBinding) {
      notes.push(`Execution binding: ${agentBinding}`);
    }
    if (agentId) {
      const agent = findAgentById(context.agents, agentId);
      notes.push(agent
        ? `Fixed agent: ${agent.name} (${agent.status})`
        : hasRoster
          ? 'Fixed agent: not found in current roster'
          : 'Fixed agent compatibility skipped because roster is unavailable');
    }

    const requiredCapabilities = readStringArray(node.config.requiredCapabilities);
    if (requiredCapabilities.length > 0) {
      notes.push(buildCapabilityMatchNote('Execution candidates', requiredCapabilities, context));
    }
  }

  return notes;
}

function topologicallyOrderNodes(definition: WorkflowDefinition): string[] {
  const incoming = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  const adjacency = new Map<string, string[]>();

  for (const edge of definition.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }

  const queue = definition.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) {
      continue;
    }
    ordered.push(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      incoming.set(targetId, (incoming.get(targetId) ?? 1) - 1);
      if ((incoming.get(targetId) ?? 0) === 0) {
        queue.push(targetId);
      }
    }
  }

  for (const node of definition.nodes) {
    if (!ordered.includes(node.id)) {
      ordered.push(node.id);
    }
  }

  return ordered;
}

function findUnreachableNodeIds(definition: WorkflowDefinition, startNodeId?: string): string[] {
  if (!startNodeId) {
    return definition.nodes.map((node) => node.id);
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }

  const visited = new Set<string>();
  const stack = [startNodeId];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      stack.push(targetId);
    }
  }

  return definition.nodes.filter((node) => !visited.has(node.id)).map((node) => node.id);
}

function detectCycleNodeIds(definition: WorkflowDefinition): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const cycleNodes = new Set<string>();

  const visit = (nodeId: string): void => {
    if (active.has(nodeId)) {
      cycleNodes.add(nodeId);
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    active.add(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      visit(targetId);
      if (active.has(targetId)) {
        cycleNodes.add(targetId);
      }
    }
    active.delete(nodeId);
  };

  for (const node of definition.nodes) {
    visit(node.id);
  }

  return Array.from(cycleNodes);
}

function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }
  return Array.from(duplicates);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function referencesAgentRoster(node: WorkflowDefinition['nodes'][number]): boolean {
  return node.type === 'route-agent'
    || node.type === 'execute-agent'
    || node.type === 'ai-decision';
}

function findAgentById(agents: WorkflowCompilerAgentSummary[], agentId: string): WorkflowCompilerAgentSummary | null {
  return agents.find((agent) => agent.agentId === agentId) ?? null;
}

function findCompatibleAgents(
  agents: WorkflowCompilerAgentSummary[],
  requiredCapabilities: string[],
): WorkflowCompilerAgentSummary[] {
  if (requiredCapabilities.length === 0) {
    return [];
  }

  const required = requiredCapabilities.map((capability) => capability.toLowerCase());
  return agents.filter((agent) => {
    const advertised = new Set(agent.baseCapabilities.map((capability) => capability.toLowerCase()));
    return required.every((capability) => advertised.has(capability));
  });
}

function isActiveAgentStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'active' || normalized === 'online' || normalized === 'ready';
}

function buildCapabilityMatchNote(
  label: string,
  requiredCapabilities: string[],
  context: WorkflowCompilerContext,
): string {
  if (context.rosterStatus !== 'available') {
    return `${label}: roster unavailable`;
  }

  const matches = findCompatibleAgents(context.agents, requiredCapabilities);
  if (matches.length === 0) {
    return `${label}: none for ${requiredCapabilities.join(', ')}`;
  }

  return `${label}: ${formatAgentNames(matches)}`;
}

function formatAgentNames(agents: WorkflowCompilerAgentSummary[]): string {
  const visible = agents.slice(0, 4).map((agent) => agent.name);
  if (agents.length <= 4) {
    return visible.join(', ');
  }
  return `${visible.join(', ')} +${agents.length - 4} more`;
}
