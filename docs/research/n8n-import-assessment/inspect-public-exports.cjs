/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Inspect three fixed public workflow exports without executing or importing them.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Run the bounded analysis-only intake over those same official exports and report compatibility blockers.
 */
'use strict';

const { createHash } = require('node:crypto');
const { compileWorkflowSpec } = require('../../../src/features/swarm-apps/services/workflow-publish-compiler.ts');
const { analyzeN8nImport } = require('../../../src/features/workflow-studio/services/n8n-import-analyzer.ts');

const sources = [
  ['starter-chat', 'https://raw.githubusercontent.com/n8n-io/self-hosted-ai-starter-kit/refs/heads/main/n8n/demo-data/workflows/srOnR8PAY3u4RSwb.json'],
  ['merge-template-655', 'https://api.n8n.io/workflows/templates/655'],
  ['if-boolean-fixture', 'https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/If/test/v2/IfV2.boolean.json'],
];

function summarizeNode(node) {
  const parameters = node.parameters ?? {};
  return {
    id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion,
    parameterKeys: Object.keys(parameters), credentialTypes: Object.keys(node.credentials ?? {}),
    containsCode: typeof parameters.jsCode === 'string',
    ...(parameters.mode ? { mode: parameters.mode } : {}),
    ...(parameters.fieldsToMatchString ? { matchingFields: parameters.fieldsToMatchString } : {}),
    ...(parameters.conditions ? { conditions: parameters.conditions } : {}),
    ...(Array.isArray(parameters.data) ? { inputItemCount: parameters.data.length } : {}),
  };
}

function summarizeEdges(workflow) {
  const edges = [];
  for (const [source, channels] of Object.entries(workflow.connections ?? {})) {
    for (const [channel, outputs] of Object.entries(channels)) {
      outputs.forEach((connections, sourceOutputIndex) => {
        for (const connection of connections ?? []) {
          edges.push({ source, channel, sourceOutputIndex, target: connection.node,
            targetInputIndex: connection.index, targetChannel: connection.type });
        }
      });
    }
  }
  return edges;
}

function compilerDisposition(workflow, edges) {
  const ids = new Map(workflow.nodes.map((node) => [node.name, node.id]));
  try {
    compileWorkflowSpec({ name: 'n8n-assessment', mode: 'graph', graph: {
      nodes: workflow.nodes.map((node) => ({ id: node.id, title: node.name,
        type: node.type, config: node.parameters })),
      edges: edges.map((edge, index) => ({ id: `e${index}`, source: ids.get(edge.source),
        target: ids.get(edge.target) })),
    } }, 'person');
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error: error.message };
  }
}

async function inspectSource([sample, url]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error(`${sample}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2_000_000) throw new Error(`${sample}: oversized assessment input`);
  const envelope = JSON.parse(bytes.toString('utf8'));
  const workflow = envelope.workflow ?? envelope;
  const edges = summarizeEdges(workflow);
  const analysis = analyzeN8nImport(bytes.toString('utf8'));
  return {
    sample, url, fetchedAt: new Date().toISOString(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    name: envelope.name ?? workflow.name,
    active: workflow.active ?? 'not specified', settings: workflow.settings ?? {},
    nodeCount: workflow.nodes.length, edgeCount: edges.length,
    nodes: workflow.nodes.map(summarizeNode), edges,
    pinnedItemCounts: Object.fromEntries(Object.entries(workflow.pinData ?? {})
      .map(([name, items]) => [name, Array.isArray(items) ? items.length : null])),
    analysis: {
      sourceSha256: analysis.sourceSha256,
      analysisOnly: analysis.analysisOnly,
      executable: analysis.executable,
      publishable: analysis.publishable,
      flags: analysis.flags,
      blockers: analysis.blockers,
      nodes: analysis.nodes.map((node) => ({ node: node.node, type: node.type, typeVersion: node.typeVersion,
        status: node.status, reasons: node.reasons })),
    },
    directTypeCopy: compilerDisposition(workflow, edges),
  };
}

Promise.all(sources.map(inspectSource)).then((samples) => {
  console.log(JSON.stringify({ evidenceKind: 'public JSON inspection; no n8n runtime execution',
    privacy: 'No credential IDs/names/values, code bodies or item payloads retained', samples }, null, 2));
}).catch((error) => { console.error(error); process.exitCode = 1; });
