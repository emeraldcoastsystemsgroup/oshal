/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com | Bounded, analysis-only n8n JSON intake. Preserve type/version and port topology in a safe report; never produce an executable workflow or expose parameters/credentials.
 * 2   | maintainer@emeraldcoastsystemsgroup.com | Split analyzeN8nImport into parse, node, connection, flag and blocker helpers (each under 50 lines) with the refusal order unchanged, and added JSDoc to the exported contract.
 */

import { createHash } from 'node:crypto';

const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 32;
const MAX_VALUES = 50_000;
const MAX_NODES = 200;
const MAX_CONNECTIONS = 400;
const MAX_PORT = 15;
const SAFE_TYPE = /^[A-Za-z0-9@/_-][A-Za-z0-9@/_.-]*$/;
const SAFE_CHANNEL = /^[A-Za-z0-9_]+$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** @description Review status of one imported node: configurable later, or blocked outright. */
export type N8nImportNodeStatus = 'needs_configuration' | 'unsupported';

/** @description One source node, identified only by its position in the export. */
export interface N8nImportNodeReport {
  /** Opaque position in the imported node array; source names and IDs are not echoed. */
  node: number;
  type: string;
  typeVersion: string;
  status: N8nImportNodeStatus;
  reasons: string[];
}

/** @description One source connection with its exact channel and port indexes. */
export interface N8nImportConnectionReport {
  sourceNode: number;
  sourceChannel: string;
  sourceOutput: number;
  targetNode: number;
  targetChannel: string;
  targetInput: number;
}

/** @description The whole analysis report; the literal flags keep it from ever being mistaken for a runnable workflow. */
export interface N8nImportAnalysis {
  format: 'n8n';
  sourceSha256: string;
  nodeCount: number;
  connectionCount: number;
  nodes: N8nImportNodeReport[];
  connections: N8nImportConnectionReport[];
  flags: {
    sourceActive: boolean;
    hasCredentialReferences: boolean;
    hasEmbeddedAuthLikeData: boolean;
    hasExpressions: boolean;
    hasPinnedData: boolean;
    hasNonMainConnections: boolean;
    hasPortIndexes: boolean;
    hasCycle: boolean;
    hasMultipleTriggers: boolean;
    hasMissingNodeIds: boolean;
  };
  blockers: string[];
  analysisOnly: true;
  executable: false;
  publishable: false;
}

/** @description A refused import, carrying a stable machine-readable code and no source content. */
export class N8nImportAnalysisError extends Error {
  constructor(readonly code: string) {
    super(`n8n import analysis refused: ${code}`);
    this.name = 'N8nImportAnalysisError';
  }
}

function refuse(code: string): never {
  throw new N8nImportAnalysisError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  return isRecord(value) ? value : refuse(code);
}

function boundedText(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) refuse(code);
  return value;
}

function boundedPort(value: unknown, code: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_PORT) refuse(code);
  return value as number;
}

/** Scan the whole parsed input before interpretation; no nested source object is copied out. */
function checkShapeAndSignals(root: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  let hasExpressions = false;
  let hasEmbeddedAuthLikeData = false;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > MAX_VALUES) refuse('value_limit_exceeded');
    if (depth > MAX_DEPTH) refuse('depth_limit_exceeded');
    if (typeof value === 'string') {
      if (value.includes('={{') || value.includes('{{ $')) hasExpressions = true;
      if (/Bearer\s+\S{8,}|(?:token|password|api[-_]?key|secret)\s*[=:]\s*\S{6,}/i.test(value)) {
        hasEmbeddedAuthLikeData = true;
      }
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(childKey)) refuse('unsafe_object_key');
      if (/(authorization|bearer|password|secret|access[-_]?token|api[-_]?key)/i.test(childKey) && child !== null) {
        hasEmbeddedAuthLikeData = true;
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return { hasExpressions, hasEmbeddedAuthLikeData };
}

function nodeReasons(type: string, version: string, node: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  if (type === 'n8n-nodes-base.manualTrigger' && version === '1') {
    reasons.push('manual_ticket_intake_binding_required');
    const parameters = requiredRecord(node.parameters ?? {}, 'invalid_node_parameters');
    if (Object.keys(parameters).length) reasons.push('unknown_manual_trigger_options');
  } else if (type === 'n8n-nodes-base.code') {
    reasons.push('imported_code_not_allowed');
  } else if (type === 'n8n-nodes-base.if') {
    reasons.push('per_item_branch_and_coercion_not_supported');
  } else if (type === 'n8n-nodes-base.merge') {
    reasons.push('item_merge_not_supported');
  } else if (type === 'n8n-nodes-base.wait') {
    reasons.push('timer_webhook_form_resume_not_supported');
  } else if (type === 'n8n-nodes-base.executeWorkflow') {
    reasons.push('sub_workflow_execution_not_supported');
  } else {
    reasons.push('node_version_adapter_not_registered');
  }
  if (node.disabled === true) reasons.push('disabled_node_semantics_not_supported');
  if (node.continueOnFail === true || node.retryOnFail === true || node.alwaysOutputData === true || node.executeOnce === true) {
    reasons.push('execution_options_not_supported');
  }
  if (isRecord(node.credentials) && Object.keys(node.credentials).length) reasons.push('credential_rebinding_required');
  return reasons;
}

function hasCycle(nodeCount: number, edges: N8nImportConnectionReport[]): boolean {
  const next: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const edge of edges) next[edge.sourceNode - 1].push(edge.targetNode - 1);
  const marks = new Array<number>(nodeCount).fill(0);
  function visit(index: number): boolean {
    if (marks[index] === 1) return true;
    if (marks[index] === 2) return false;
    marks[index] = 1;
    for (const child of next[index]) if (visit(child)) return true;
    marks[index] = 2;
    return false;
  }
  return marks.some((_, index) => visit(index));
}

interface ParsedWorkflow {
  workflow: Record<string, unknown> & { nodes: unknown[]; connections: Record<string, unknown> };
  signals: { hasExpressions: boolean; hasEmbeddedAuthLikeData: boolean };
}

interface NodeAnalysis {
  nodes: N8nImportNodeReport[];
  names: Map<string, number>;
  hasMissingNodeIds: boolean;
}

/** Bound, parse and shape-check the source before any node is interpreted. */
function parseWorkflow(jsonText: string): ParsedWorkflow {
  if (typeof jsonText !== 'string') refuse('invalid_input');
  if (Buffer.byteLength(jsonText, 'utf8') > MAX_BYTES) refuse('byte_limit_exceeded');
  let parsed: unknown;
  // A parse failure is caller input, surfaced as a typed refusal rather than swallowed.
  try { parsed = JSON.parse(jsonText); } catch { refuse('invalid_json'); }
  const signals = checkShapeAndSignals(parsed);
  const envelope = requiredRecord(parsed, 'invalid_export');
  const workflow = requiredRecord('nodes' in envelope ? envelope : envelope.workflow, 'invalid_workflow');
  if (!Array.isArray(workflow.nodes) || !isRecord(workflow.connections)) refuse('invalid_graph');
  if (workflow.nodes.length === 0 || workflow.nodes.length > MAX_NODES) refuse('node_limit_or_empty_graph');
  return { workflow: workflow as ParsedWorkflow['workflow'], signals };
}

function analyzeNode(raw: unknown, index: number, names: Map<string, number>, ids: Set<string>) {
  const node = requiredRecord(raw, 'invalid_node');
  // Some official fixture exports omit IDs. Names still define n8n connections;
  // the review draft will mint local IDs without claiming these are source IDs.
  const id = node.id === undefined ? undefined : boundedText(node.id, 160, 'invalid_node_id');
  const name = boundedText(node.name, 160, 'invalid_node_name');
  const type = boundedText(node.type, 160, 'invalid_node_type');
  if (!SAFE_TYPE.test(type)) refuse('invalid_node_type');
  if ((id !== undefined && ids.has(id)) || names.has(name)) refuse('duplicate_node_identity');
  if (id !== undefined) ids.add(id);
  names.set(name, index + 1);
  const versionNumber = node.typeVersion;
  if (typeof versionNumber !== 'number' || !Number.isFinite(versionNumber) || versionNumber <= 0 || versionNumber > 1000) {
    refuse('invalid_node_version');
  }
  const typeVersion = String(versionNumber);
  const reasons = nodeReasons(type, typeVersion, node);
  const report: N8nImportNodeReport = { node: index + 1, type, typeVersion,
    status: reasons.some((reason) => reason !== 'manual_ticket_intake_binding_required' && reason !== 'credential_rebinding_required')
      ? 'unsupported' : 'needs_configuration', reasons };
  return { report, missingId: id === undefined };
}

function analyzeNodes(rawNodes: unknown[]): NodeAnalysis {
  const names = new Map<string, number>();
  const ids = new Set<string>();
  let hasMissingNodeIds = false;
  const nodes = rawNodes.map((raw, index) => {
    const { report, missingId } = analyzeNode(raw, index, names, ids);
    if (missingId) hasMissingNodeIds = true;
    return report;
  });
  return { nodes, names, hasMissingNodeIds };
}

function analyzeLinks(
  links: unknown,
  source: { sourceNode: number; sourceChannel: string; sourceOutput: number },
  names: Map<string, number>,
  connections: N8nImportConnectionReport[],
): void {
  if (!Array.isArray(links)) refuse('invalid_connection_output');
  for (const raw of links) {
    if (connections.length >= MAX_CONNECTIONS) refuse('connection_limit_exceeded');
    const link = requiredRecord(raw, 'invalid_connection');
    const targetName = boundedText(link.node, 160, 'invalid_connection_target');
    const targetNode = names.get(targetName);
    if (!targetNode) refuse('unknown_connection_target');
    const targetChannel = boundedText(link.type, 80, 'invalid_connection_target_channel');
    if (!SAFE_CHANNEL.test(targetChannel)) refuse('invalid_connection_target_channel');
    connections.push({ ...source, targetNode, targetChannel,
      targetInput: boundedPort(link.index, 'invalid_connection_target_port') });
  }
}

function analyzeConnections(rawConnections: Record<string, unknown>, names: Map<string, number>): N8nImportConnectionReport[] {
  const connections: N8nImportConnectionReport[] = [];
  for (const [sourceName, byChannelRaw] of Object.entries(rawConnections)) {
    const sourceNode = names.get(sourceName);
    if (!sourceNode) refuse('unknown_connection_source');
    const byChannel = requiredRecord(byChannelRaw, 'invalid_connection_group');
    for (const [sourceChannel, outputGroups] of Object.entries(byChannel)) {
      if (!SAFE_CHANNEL.test(sourceChannel) || sourceChannel.length > 80 || !Array.isArray(outputGroups)) refuse('invalid_connection_channel');
      for (let output = 0; output < outputGroups.length; output++) {
        boundedPort(output, 'output_port_limit_exceeded');
        analyzeLinks(outputGroups[output], { sourceNode, sourceChannel, sourceOutput: output }, names, connections);
      }
    }
  }
  return connections;
}

function buildFlags(parsed: ParsedWorkflow, analysis: NodeAnalysis, connections: N8nImportConnectionReport[]): N8nImportAnalysis['flags'] {
  const { workflow, signals } = parsed;
  const pinData = workflow.pinData;
  return {
    sourceActive: workflow.active === true,
    hasCredentialReferences: workflow.nodes.some((raw) => isRecord(raw) && isRecord(raw.credentials) && Object.keys(raw.credentials).length > 0),
    hasEmbeddedAuthLikeData: signals.hasEmbeddedAuthLikeData,
    hasExpressions: signals.hasExpressions,
    hasPinnedData: isRecord(pinData) && Object.keys(pinData).length > 0,
    hasNonMainConnections: connections.some((edge) => edge.sourceChannel !== 'main' || edge.targetChannel !== 'main'),
    hasPortIndexes: connections.some((edge) => edge.sourceOutput !== 0 || edge.targetInput !== 0),
    hasCycle: hasCycle(analysis.nodes.length, connections),
    hasMultipleTriggers: analysis.nodes.filter((node) => /trigger$/i.test(node.type)).length > 1,
    hasMissingNodeIds: analysis.hasMissingNodeIds,
  };
}

function buildBlockers(flags: N8nImportAnalysis['flags']): string[] {
  return [
    'analysis_only_no_execution_adapter',
    ...(flags.hasNonMainConnections ? ['non_main_connection_semantics_unavailable'] : []),
    ...(flags.hasPortIndexes ? ['port_index_semantics_unavailable'] : []),
    ...(flags.hasCycle ? ['cycle_semantics_unavailable'] : []),
    ...(flags.hasMultipleTriggers ? ['multiple_trigger_semantics_unavailable'] : []),
    ...(flags.hasPinnedData ? ['pinned_sample_data_not_imported'] : []),
    ...(flags.hasExpressions ? ['expression_translation_unavailable'] : []),
  ];
}

/**
 * @description Analyze one n8n export (or an explicit {workflow} wrapper) without creating a draft,
 * running any node, binding credentials, activating a trigger, or invoking publication.
 * The report deliberately omits source names/IDs, parameters, code, credentials and item data.
 * @param jsonText - The raw export text, at most 512 KiB of UTF-8.
 * @returns A topology-only report that is always analysisOnly, never executable or publishable.
 * @throws N8nImportAnalysisError with a stable code when the input is refused.
 */
export function analyzeN8nImport(jsonText: string): N8nImportAnalysis {
  const parsed = parseWorkflow(jsonText);
  const analysis = analyzeNodes(parsed.workflow.nodes);
  const connections = analyzeConnections(parsed.workflow.connections, analysis.names);
  const flags = buildFlags(parsed, analysis, connections);
  return {
    format: 'n8n', sourceSha256: createHash('sha256').update(jsonText).digest('hex'),
    nodeCount: analysis.nodes.length, connectionCount: connections.length, nodes: analysis.nodes, connections,
    flags, blockers: buildBlockers(flags), analysisOnly: true, executable: false, publishable: false,
  };
}
