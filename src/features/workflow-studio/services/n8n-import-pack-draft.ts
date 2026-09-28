/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: turn an n8n analysis report into a private Packs review draft (pack.json descriptor, workflow.json topology, README.md) with locally minted node ids and only honest native proposals (a Studio Start marker for Manual Trigger v1). The draft is marked n8n-analysis, analysisOnly and non-executable so the Packs deploy route refuses it. Split into node, edge, candidate, descriptor and README builders.
 */
/**
 * A redacted, non-executable handoff from n8n analysis to the existing Packs UI.
 * This is not a Workflow Studio processDefinition and must never be deployed.
 */
import { randomUUID } from 'node:crypto';
import type { N8nImportAnalysis } from './n8n-import-analyzer';
import { createWorkflowNode } from '../schemas/workflow-studio-schemas';

/** @description The three artifacts a review draft writes next to its analysis.json. */
export interface N8nImportPackDraft {
  descriptor: Record<string, unknown>;
  workflow: Record<string, unknown>;
  readme: string;
}

interface DraftCounts {
  unsupportedCount: number;
  needsConfigurationCount: number;
}

function draftNodes(report: N8nImportAnalysis, localIds: string[]) {
  return report.nodes.map((source) => ({
    id: localIds[source.node - 1],
    sourceOrdinal: source.node,
    label: `Step ${source.node}`,
    type: source.type,
    typeVersion: source.typeVersion,
    status: source.status,
    reasons: source.reasons,
  }));
}

function draftEdges(report: N8nImportAnalysis, localIds: string[]) {
  return report.connections.map((source, index) => ({
    id: `connection-${index + 1}`,
    from: localIds[source.sourceNode - 1],
    to: localIds[source.targetNode - 1],
    sourceChannel: source.sourceChannel,
    sourceOutput: source.sourceOutput,
    targetChannel: source.targetChannel,
    targetInput: source.targetInput,
  }));
}

/** Reuse the Studio node factory only where the mapping is honest: Manual Trigger v1 → a Start marker proposal. */
function nativeCandidates(report: N8nImportAnalysis) {
  return report.nodes
    .filter((node) => node.type === 'n8n-nodes-base.manualTrigger' && node.typeVersion === '1'
      && node.reasons.every((reason) => reason === 'manual_ticket_intake_binding_required'))
    .map((source) => ({
      sourceOrdinal: source.node,
      status: 'proposal_only' as const,
      requiredBinding: 'manual_ticket_intake_binding_required',
      node: createWorkflowNode('start', { x: 80, y: 80 + (source.node - 1) * 120 }),
    }));
}

function draftDescriptor(name: string, report: N8nImportAnalysis, counts: DraftCounts) {
  return {
    name,
    mode: 'n8n-analysis',
    description: 'Imported n8n process review draft. No actions, bots or triggers are installed.',
    sourceFormat: 'n8n',
    sourceSha256: report.sourceSha256,
    nodeCount: report.nodeCount,
    connectionCount: report.connectionCount,
    unsupportedCount: counts.unsupportedCount,
    needsConfigurationCount: counts.needsConfigurationCount,
    analysisOnly: true,
    executable: false,
    publishable: false,
    files: ['pack.json', 'workflow.json', 'analysis.json', 'README.md'],
  };
}

function draftReadme(name: string, report: N8nImportAnalysis, counts: DraftCounts): string {
  const lines = [
    `# ${name} — n8n process review draft`,
    '',
    '**Analysis only.** This pack cannot deploy, publish, bind credentials or create tickets.',
    'The source export was not retained. Source node names, IDs, parameters, code, credentials and pinned data were discarded.',
    `Source SHA-256: \`${report.sourceSha256}\``,
    `Nodes: ${report.nodeCount}; connections: ${report.connectionCount}; unsupported: ${counts.unsupportedCount}; need configuration: ${counts.needsConfigurationCount}.`,
    '',
    'Codex Packer can use this as an interview brief for a new native process, but its current deploy path does not execute this graph. Every source step needs an explicit, reviewed native operation and a separate equivalence test.',
    'Manual Trigger v1 may receive a Studio Start marker proposal via the existing node factory; it still needs a ticket-intake binding and does not activate anything.',
    '',
    '## Steps',
    '',
    '| Step | Source type | Version | Status | Reasons |',
    '| --- | --- | --- | --- | --- |',
    ...report.nodes.map((node) => `| ${node.node} | \`${node.type}\` | ${node.typeVersion} | ${node.status} | ${node.reasons.join(', ')} |`),
    '',
    '## Connections',
    '',
    '| From | Source port | To | Target port |',
    '| --- | --- | --- | --- |',
    ...report.connections.map((edge) => `| ${edge.sourceNode} | ${edge.sourceChannel}[${edge.sourceOutput}] | ${edge.targetNode} | ${edge.targetChannel}[${edge.targetInput}] |`),
    '',
    '## Global blockers',
    '',
    ...report.blockers.map((blocker) => `- ${blocker}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * @description Build the private review draft for one analyzed n8n export. Source node names and
 * ids never reach the draft: nodes get fresh local UUIDs and are labelled by ordinal.
 * @param name - The validated pack slug the draft is saved under.
 * @param report - The analysis report from analyzeN8nImport.
 * @returns The pack descriptor, the topology document and the README text.
 */
export function buildN8nImportPackDraft(name: string, report: N8nImportAnalysis): N8nImportPackDraft {
  const localIds = report.nodes.map(() => randomUUID());
  const unsupportedCount = report.nodes.filter((node) => node.status === 'unsupported').length;
  const counts: DraftCounts = { unsupportedCount, needsConfigurationCount: report.nodes.length - unsupportedCount };
  const workflow = {
    format: 'n8n-analysis',
    analysisOnly: true,
    executable: false,
    publishable: false,
    sourceSha256: report.sourceSha256,
    flags: report.flags,
    blockers: report.blockers,
    nodes: draftNodes(report, localIds),
    edges: draftEdges(report, localIds),
    nativeCandidates: nativeCandidates(report),
  };
  return { descriptor: draftDescriptor(name, report, counts), workflow, readme: draftReadme(name, report, counts) };
}
