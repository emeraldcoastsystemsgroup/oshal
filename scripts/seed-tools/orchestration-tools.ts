/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from seed-tools.ts (1000-line cap decomposition): Orchestration tool definitions (workflow-studio API tool)
 */

import { ToolType, AuthMode, InstallMethod } from '../../src/shared/types/tool';
import type { CreateToolInput } from '../../src/entities/tool/schemas/tool-schemas';

/**
 * @description Orchestration tool definitions (workflow-studio API tool) — part of the
 * seed catalog aligned with the any-bot/Dockerfile baseline image.
 */
export const orchestrationTools: CreateToolInput[] = [
  {
    name: 'workflow-studio',
    displayName: 'Workflow Studio',
    type: ToolType.API,
    category: 'orchestration',
    version: '1.0.0',
    description: 'Design, validate, compile, and manage swarm workflow definitions via the Workflow Studio API. Supports creating workflows with 14 node types, wiring edges, running graph validation, producing compile previews, and managing version history.',
    installSpec: {
      method: InstallMethod.NONE,
    },
    skills: ['workflow-design', 'process-architecture', 'orchestration', 'workflow-validation', 'workflow-deployment'],
    selectorFragment: 'Workflow design, process automation, orchestration graph authoring, workflow validation and compilation',
    routingTags: ['workflow', 'process', 'orchestration', 'automation', 'pipeline', 'flow', 'workflow-design'],
    authGroup: 'workflow',
    defaultAuthMode: AuthMode.AUTO,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['getCatalog', 'listDefinitions', 'getDefinition', 'createDefinition', 'saveDefinition', 'validateDefinition', 'compileDefinition', 'duplicateDefinition', 'listVersions', 'getVersion', 'forkVersion'],
          description: 'The workflow studio operation to perform',
        },
        definitionId: { type: 'string', description: 'Workflow definition UUID (required for most operations)' },
        version: { type: 'number', description: 'Version number (for version-specific operations)' },
        name: { type: 'string', description: 'Workflow name (for create/duplicate)' },
        description: { type: 'string', description: 'Workflow description' },
        nodes: {
          type: 'array',
          description: 'Array of workflow nodes (for save)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['start', 'intake-source', 'planner', 'route-agent', 'ai-decision', 'logic-gate', 'execute-agent', 'parallel-split', 'approval-gate', 'verify-output', 'review', 'deliver', 'escalate', 'parallel-join'] },
              title: { type: 'string' },
              position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
              config: { type: 'object' },
            },
          },
        },
        edges: {
          type: 'array',
          description: 'Array of workflow edges (for save)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              source: { type: 'string' },
              target: { type: 'string' },
              label: { type: 'string' },
              condition: { type: 'string' },
            },
          },
        },
      },
      required: ['action'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object', description: 'Response payload (varies by action)' },
      },
    },
    usageInstructions: `Use workflow-studio to design and manage swarm workflow definitions.

Available actions:
- getCatalog: Get the full node type catalog (14 types) with config schemas
- listDefinitions: List all saved workflow definitions
- createDefinition: Create a new blank workflow (provide name, description)
- getDefinition: Load a specific workflow by definitionId
- saveDefinition: Save nodes and edges to a workflow (provide definitionId, nodes, edges)
- validateDefinition: Run graph validation on a workflow (checks for cycles, dangling edges, missing nodes, agent compatibility)
- compileDefinition: Produce a compile preview with runtime bindings and integration notes
- duplicateDefinition: Clone an existing workflow with a new name
- listVersions: See version history for a workflow
- getVersion: Load a specific historical version
- forkVersion: Create a new draft from a historical version

Design principles:
- Every workflow needs exactly one start node
- Every workflow should have at least one deliver or escalate terminal
- parallel-split nodes need matching parallel-join nodes
- ai-decision and logic-gate nodes need 2+ outgoing edges with labels
- route-agent nodes should specify a phase in config
- Always validate before compiling`,
    examples: [
      { action: 'getCatalog', description: 'Get available node types' },
      { action: 'createDefinition', name: 'bug-triage', description: 'Create a bug triage workflow' },
      { action: 'validateDefinition', definitionId: '<uuid>', description: 'Validate a workflow graph' },
    ],
    requiresApproval: false,
    timeoutMs: 30000,
    tags: ['workflow', 'orchestration', 'process-design', 'swarm'],
    enabled: true,
    registeredBy: 'system',
  },
];
